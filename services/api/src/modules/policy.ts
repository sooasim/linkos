// F-139 정책 강제 — effective org policy for a user (strictest across all active memberships).
// Kept dependency-free (db + domain only) so card/meeting/integration can call it without import cycles.
import { type OrgPolicies, type OrgRole, exportAllowed, mergePolicies, profilePolicyViolations } from "@linkos/domain";
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
