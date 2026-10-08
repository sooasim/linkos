// F-139 정책 강제 — effective org policy for a user (strictest across all active memberships).
// Kept dependency-free (db + domain only) so card/meeting/integration can call it without import cycles.
import { CRM_PROVIDERS, type CrmProvider, type CrmSyncDecision, type OrgPolicies, type OrgRole, crmSyncDecision, exportAllowed, mergePolicies, profilePolicyViolations, supportsObject } from "@linkos/domain";
import { type Db, pool, q } from "../lib/db";
import { ApiError } from "../lib/errors";

export interface EffectivePolicy {
  policy: OrgPolicies;
  roles: OrgRole[];
  orgIds: string[];
}

export async function effectivePolicy(userId: string, db: Db = pool()): Promise<EffectivePolicy> {
  const rows = await q<{ organization_id: string; role: OrgRole; policies: OrgPolicies }>(
    `SELECT m.organization_id, m.role, o.policies FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.status = 'active'`,
    [userId],
    db,
  );
  return { policy: mergePolicies(rows.map((r) => r.policies ?? {})), roles: rows.map((r) => r.role), orgIds: rows.map((r) => r.organization_id) };
}

export function policyViolation(message: string, details?: unknown) {
  return new ApiError(422, "policy_violation", message, details);
}

/** Export of contacts (file, Google Sheets) is blocked when any membership role is in `blockExportRoles`. */
export async function assertExportAllowed(userId: string, db: Db = pool()): Promise<void> {
  const e = await effectivePolicy(userId, db);
  if (!exportAllowed(e.roles, e.policy)) throw new ApiError(403, "export_blocked_by_policy", "조직 정책에 따라 내보내기가 제한되어 있습니다.");
}

export async function assertRecordingPolicy(userId: string, consentPolicy: string, db: Db = pool()): Promise<void> {
  const e = await effectivePolicy(userId, db);
  if (e.policy.requireAllPartyRecordingConsent && consentPolicy !== "all_party") {
    throw policyViolation("조직 정책상 모든 참석자의 녹음 동의(all_party)가 필요합니다.", { required: "all_party" });
  }
}

/** Card field policy applies to the profile attached to an org (profiles.organization_id), using that org's policy. */
export async function assertProfilePolicy(profileId: string, fields: { type: string; visibility: string; value?: string }[], db: Db = pool()): Promise<void> {
  const r = await q<{ policies: OrgPolicies }>(
    `SELECT o.policies FROM profiles p JOIN organizations o ON o.id = p.organization_id
     JOIN organization_members m ON m.organization_id = o.id AND m.user_id = p.user_id AND m.status = 'active' WHERE p.id = $1`,
    [profileId],
    db,
  );
  if (!r.length) return;
  const v = profilePolicyViolations(fields, mergePolicies(r.map((x) => x.policies ?? {})));
  if (v.length) throw policyViolation(v[0]!.message, { violations: v });
}

// ---------- F-139 CRM sync required ----------
async function orgPolicy(orgId: string, db: Db): Promise<OrgPolicies> {
  const r = await q<{ policies: OrgPolicies | null }>("SELECT policies FROM organizations WHERE id=$1", [orgId], db);
  return r[0]?.policies ?? {};
}

async function connectedCrms(userId: string, db: Db): Promise<CrmProvider[]> {
  const rows = await q<{ provider: CrmProvider }>(
    "SELECT provider FROM integration_accounts WHERE user_id=$1 AND status='active' AND provider = ANY($2::text[]) ORDER BY created_at",
    [userId, [...CRM_PROVIDERS]],
    db,
  );
  return rows.map((r) => r.provider);
}

/** Decision for one contact under its organization's policy (personal contacts → not required). */
export async function crmSyncRequirement(contactId: string, db: Db = pool()): Promise<CrmSyncDecision & { ownerUserId: string | null; organizationId: string | null }> {
  const rows = await q<{ owner_user_id: string; organization_id: string | null; scope: string; ownership: string }>(
    "SELECT owner_user_id, organization_id, scope, ownership FROM contacts WHERE id=$1 AND deleted_at IS NULL",
    [contactId],
    db,
  );
  const row = rows[0];
  if (!row?.organization_id) return { required: false, provider: null, violation: null, ownerUserId: row?.owner_user_id ?? null, organizationId: null };
  const d = crmSyncDecision(await orgPolicy(row.organization_id, db), row, await connectedCrms(row.owner_user_id, db));
  return { ...d, ownerUserId: row.owner_user_id, organizationId: row.organization_id };
}

/**
 * Gate for moving a contact into company ownership (share-to-org / lead capture): when the org requires CRM sync,
 * the owning member must have an allowed CRM connected. Throws 422 policy_violation otherwise.
 */
export async function assertCrmSyncPolicy(orgId: string, ownerUserId: string, db: Db = pool()): Promise<void> {
  const policy = await orgPolicy(orgId, db);
  const d = crmSyncDecision(policy, { scope: "org", ownership: "company" }, await connectedCrms(ownerUserId, db));
  if (d.violation) {
    throw policyViolation("조직 정책상 회사 연락처는 CRM 동기화가 필요합니다. CRM 계정을 먼저 연결하세요.", { required: "crm_sync", providers: policy.crmSyncProviders ?? null });
  }
}

/**
 * Enforcement: enqueue the CRM push the policy requires (idempotent per contact version; records already mapped are
 * followed by the regular contact.updated consumer). Call with the caller's transaction client. A violation is
 * returned, not thrown, so background paths never lose the contact.
 */
export async function enqueueRequiredCrmSync(db: Db, contactId: string): Promise<CrmSyncDecision & { queued: boolean }> {
  const d = await crmSyncRequirement(contactId, db);
  if (!d.required || !d.provider || !d.ownerUserId) return { required: d.required, provider: d.provider, violation: d.violation, queued: false };
  // company records go in as leads where the CRM has a lead object, otherwise as contacts
  const object = supportsObject(d.provider, "lead") ? "lead" : "contact";
  const r = await q(
    `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider)
     SELECT a.id, 'crm.' || $3::text || '.upsert', jsonb_build_object('contactId', ct.id, 'policy', 'require_crm_sync'), $3::text || ':' || ct.id || ':v' || ct.version, a.provider
     FROM contacts ct JOIN integration_accounts a ON a.user_id = ct.owner_user_id AND a.provider = $2 AND a.status = 'active'
     WHERE ct.id = $1
       AND NOT EXISTS (SELECT 1 FROM external_mappings em WHERE em.integration_account_id = a.id AND em.local_id = ct.id AND em.entity_type IN ('contact','lead'))
     ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING RETURNING id`,
    [contactId, d.provider, object],
    db,
  );
  return { required: true, provider: d.provider, violation: null, queued: r.length > 0 };
}
