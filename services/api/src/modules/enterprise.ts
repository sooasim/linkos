// enterprise module — F-135 활동 대시보드, F-139 정책 강제(설정), F-136 Data Retention(+worker purge), F-140 API 키,
// F-008 B2B SSO (per-org OIDC, PKCE + nonce, JWKS-verified id_token; SAML 2.0 in ./saml) + SCIM 2.0 provisioning.
import { createHash, randomBytes } from "node:crypto";
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  CRM_PROVIDERS,
  type ConsentType,
  ORG_ROLES,
  type OrgRole,
  type RetentionPolicy,
  emailDomain,
  generateToken,
  hasApiScope,
  normalizeEmail,
  parseApiKey,
  retentionCutoff,
  validateRetention,
} from "@linkos/domain";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized, unavailable } from "../lib/errors";
import { type Ctx, appOrigin, audit, log, rateLimit, sha256 } from "../lib/platform";
import { seal, unseal } from "./integration";
import { handleMemberDeparture, requireOrg } from "./org";
import { purgeAuditLogs } from "./auditChain";
import { isReferralCode } from "./referral";
import { enqueueRequiredCrmSync } from "./policy";
import { contactInput, insertContact } from "./relationship";
import { samlStart } from "./saml";
import { assertOrgEmailDomain, completeSsoLogin } from "./ssoLogin";
import { SSO_AVAILABLE_SQL } from "./ssoPolicy";

// ---------- F-135 ----------
export async function orgActivity(ctx: Ctx, orgId: string, days = 30) {
  await requireOrg(orgId, ctx.userId, "dashboard.read");
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  // per-member correlated counts: each probes an owner-indexed path (members are bounded), no multi-way GROUP BY join
  const members = await q<any>(
    `SELECT m.user_id, m.role, COALESCE(u.display_name, split_part(u.email,'@',1)) AS name,
       (SELECT count(*)::int FROM business_cards b WHERE b.captured_by=m.user_id AND b.captured_at > now() - ($2 || ' days')::interval) AS scans,
       (SELECT count(*)::int FROM exchange_sessions s WHERE s.sender_user_id=m.user_id AND s.created_at > now() - ($2 || ' days')::interval) AS exchanges,
       (SELECT count(*)::int FROM exchange_sessions s WHERE s.sender_user_id=m.user_id AND s.created_at > now() - ($2 || ' days')::interval AND s.state IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED')) AS exchanges_done,
       (SELECT count(*)::int FROM exchange_sessions s WHERE s.sender_user_id=m.user_id AND s.created_at > now() - ($2 || ' days')::interval AND s.state IN ('CLAIMED','SYNCED')) AS claims,
       (SELECT count(*)::int FROM meetings mt WHERE mt.owner_user_id=m.user_id AND mt.created_at > now() - ($2 || ' days')::interval) AS meetings,
       (SELECT count(*)::int FROM followups f WHERE f.owner_user_id=m.user_id AND f.created_at > now() - ($2 || ' days')::interval) AS followups,
       (SELECT count(*)::int FROM followups f WHERE f.owner_user_id=m.user_id AND f.created_at > now() - ($2 || ' days')::interval AND f.status='done') AS followups_done,
       (SELECT count(*)::int FROM introductions i WHERE i.introducer_user_id=m.user_id AND i.created_at > now() - ($2 || ' days')::interval) AS intros,
       (SELECT count(*)::int FROM introductions i WHERE i.introducer_user_id=m.user_id AND i.created_at > now() - ($2 || ' days')::interval AND (i.state='WON' OR i.outcome='won')) AS intros_won,
       (SELECT count(*)::int FROM contacts c WHERE c.organization_id=m.organization_id AND c.shared_by=m.user_id AND c.shared_at > now() - ($2 || ' days')::interval) AS shared
     FROM organization_members m JOIN users u ON u.id=m.user_id
     WHERE m.organization_id=$1 AND m.status='active' ORDER BY name LIMIT 500`,
    [orgId, d],
  );
  const keys = ["scans", "exchanges", "exchanges_done", "claims", "meetings", "followups", "followups_done", "intros", "intros_won", "shared"] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, members.reduce((a: number, m: any) => a + (m[k] ?? 0), 0)])) as Record<(typeof keys)[number], number>;
  const book = await one<{ shared: number; leads: number; unassigned: number }>(
    `SELECT count(*)::int AS shared, count(*) FILTER (WHERE ownership='company')::int AS leads,
       count(*) FILTER (WHERE ownership='company' AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=$1 AND m.user_id=contacts.owner_user_id AND m.status='active'))::int AS unassigned
     FROM contacts WHERE organization_id=$1 AND scope='org' AND deleted_at IS NULL AND merged_into_id IS NULL`,
    [orgId],
  );
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    windowDays: d,
    totals,
    rates: { exchangeCompletion: pct(totals.exchanges_done, totals.exchanges), claimConversion: pct(totals.claims, totals.exchanges_done), followupCompletion: pct(totals.followups_done, totals.followups), introWin: pct(totals.intros_won, totals.intros) },
    teamBook: book,
    members: members.map((m: any) => ({ userId: m.user_id, name: m.name, role: m.role, ...Object.fromEntries(keys.map((k) => [k, m[k]])) })),
  };
}

export async function orgAuditLog(ctx: Ctx, orgId: string, limit = 100) {
  await requireOrg(orgId, ctx.userId, "audit.read");
  const rows = await q<any>(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, u.display_name AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT $2`,
    [orgId, Math.min(500, limit)],
  );
  await audit(pool(), ctx, "org.audit_viewed", "organization", orgId, {}, orgId);
  return rows;
}

// ---------- F-139 ----------
export const policiesInput = z.object({
  requireAllPartyRecordingConsent: z.boolean().optional(),
  blockExportRoles: z.array(z.enum(ORG_ROLES)).max(5).optional(),
  minFieldVisibility: z.enum(["public", "business", "trusted"]).nullish(),
  requiredCardFields: z.array(z.enum(["email", "phone", "mobile", "website", "address"])).max(5).optional(),
  graphPersonalExposure: z.enum(["company_level", "shared_only"]).optional(),
  // F-139 "CRM sync 필수": company-owned contacts/leads are pushed to an allowed CRM of their owner
  requireCrmSync: z.boolean().optional(),
  crmSyncProviders: z.array(z.enum(CRM_PROVIDERS)).max(CRM_PROVIDERS.length).optional(),
});

export async function updatePolicies(ctx: Ctx, orgId: string, input: z.infer<typeof policiesInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "policy.manage", c);
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
    await c.query("UPDATE organizations SET policies=$2, updated_at=now() WHERE id=$1", [orgId, JSON.stringify(clean)]);
    await audit(c, ctx, "org.policies_updated", "organization", orgId, clean, orgId);
    return { policies: clean };
  });
}

// ---------- F-136 ----------
export const retentionInput = z.object({
  inactiveContactDays: z.number().int().nullish(),
  teamNoteDays: z.number().int().nullish(),
  auditLogDays: z.number().int().nullish(),
});

export async function updateRetention(ctx: Ctx, orgId: string, input: RetentionPolicy) {
  const errs = validateRetention(input);
  if (errs.length) throw badRequest("invalid_retention", errs.join("; "));
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "retention.manage", c);
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v != null));
    await c.query("UPDATE organizations SET retention=$2, updated_at=now() WHERE id=$1", [orgId, JSON.stringify(clean)]);
    await audit(c, ctx, "org.retention_updated", "organization", orgId, clean, orgId);
    return { retention: clean };
  });
}

async function retentionTargets(db: Db, orgId: string, p: RetentionPolicy, now: Date) {
  const contactCut = retentionCutoff(p.inactiveContactDays, now);
  const noteCut = retentionCutoff(p.teamNoteDays, now);
  const auditCut = retentionCutoff(p.auditLogDays, now);
  const inactive = contactCut
    ? await q<{ id: string; ownership: string }>(
        `SELECT c.id, c.ownership FROM contacts c WHERE c.organization_id=$1 AND c.scope='org' AND c.updated_at < $2
           AND NOT EXISTS (SELECT 1 FROM encounters e WHERE e.contact_id=c.id AND e.occurred_at >= $2)
           AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.contact_id=c.id AND n.created_at >= $2)
         LIMIT 5000`,
        [orgId, contactCut],
        db,
      )
    : [];
  const notes = noteCut ? await one<{ n: number }>("SELECT count(*)::int AS n FROM notes WHERE organization_id=$1 AND scope='team' AND created_at < $2", [orgId, noteCut], db) : null;
  const audits = auditCut ? await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND created_at < $2 AND action NOT LIKE 'retention.%'", [orgId, auditCut], db) : null;
  return { contactCut, noteCut, auditCut, inactive, notes: notes?.n ?? 0, audits: audits?.n ?? 0 };
}

export async function previewRetention(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "retention.manage");
  const o = await one<{ retention: RetentionPolicy }>("SELECT retention FROM organizations WHERE id=$1", [orgId]);
  const t = await retentionTargets(pool(), orgId, o?.retention ?? {}, new Date());
  return {
    policy: o?.retention ?? {},
    wouldDelete: { companyLeads: t.inactive.filter((x) => x.ownership === "company").length, teamNotes: t.notes, auditLogs: t.audits },
    wouldUnshare: { personalContacts: t.inactive.filter((x) => x.ownership !== "company").length },
  };
}

/**
 * Worker: apply each org's retention policy. Company-owned inactive leads are hard-deleted; personal contacts that
 * were shared are only unshared (they belong to the member). Every purge leaves an audit record (retention.purged).
 */
export async function processRetention(now: Date = new Date()): Promise<number> {
  const orgs = await q<{ id: string; retention: RetentionPolicy }>("SELECT id, retention FROM organizations WHERE retention <> '{}'::jsonb LIMIT 200");
  let total = 0;
  for (const o of orgs) {
    if (validateRetention(o.retention).length) continue;
    await tx(async (c) => {
      const t = await retentionTargets(c, o.id, o.retention, now);
      const leadIds = t.inactive.filter((x) => x.ownership === "company").map((x) => x.id);
      const personalIds = t.inactive.filter((x) => x.ownership !== "company").map((x) => x.id);
      if (leadIds.length) await c.query("DELETE FROM contacts WHERE id = ANY($1::uuid[]) AND organization_id=$2", [leadIds, o.id]);
      if (personalIds.length) await c.query("UPDATE contacts SET scope='personal', organization_id=NULL, shared_by=NULL, shared_at=NULL WHERE id = ANY($1::uuid[])", [personalIds]);
      const n = t.noteCut ? (await c.query("DELETE FROM notes WHERE organization_id=$1 AND scope='team' AND created_at < $2", [o.id, t.noteCut])).rowCount ?? 0 : 0;
      // §20 audit durability: purged rows leave hash-chain tombstones so the chain still verifies
      const a = t.auditCut ? await purgeAuditLogs(c, "organization_id=$1 AND created_at < $2 AND action NOT LIKE 'retention.%'", [o.id, t.auditCut], "retention") : 0;
      const sum = leadIds.length + personalIds.length + n + a;
      if (sum) {
        await audit(c, { userId: null }, "retention.purged", "organization", o.id, { companyLeadsDeleted: leadIds.length, personalUnshared: personalIds.length, teamNotesDeleted: n, auditLogsDeleted: a, policy: o.retention }, o.id);
        total += sum;
      }
    });
  }
  return total;
}

// ---------- F-140 ----------
export const apiKeyInput = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1), expiresInDays: z.number().int().min(1).max(730).nullish() });

export async function createApiKey(ctx: Ctx, orgId: string, input: z.infer<typeof apiKeyInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "apikeys.manage", c);
    const alnum = () => randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "");
    const prefix = alnum().slice(0, 8).padEnd(8, "x");
    const key = `lk_${prefix}_${generateToken(32)}`;
    const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 864e5) : null;
    const r = await one<{ id: string }>(
      "INSERT INTO api_keys (organization_id, name, prefix, key_hash, scopes, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [orgId, input.name, prefix, sha256(key), input.scopes, ctx.userId, expires],
      c,
    );
    await audit(c, ctx, "apikey.created", "api_key", r!.id, { name: input.name, scopes: input.scopes, prefix }, orgId);
    // the plaintext key is returned exactly once
    return { id: r!.id, key, prefix, scopes: input.scopes, expiresAt: expires };
  });
}

export async function listApiKeys(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "apikeys.manage");
  return q<any>(
    `SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at,
       CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at < now() THEN 'expired' ELSE 'active' END AS status
     FROM api_keys WHERE organization_id=$1 ORDER BY created_at DESC`,
    [orgId],
  );
}

export async function revokeApiKey(ctx: Ctx, orgId: string, keyId: string) {
  await requireOrg(orgId, ctx.userId, "apikeys.manage");
  const r = await one("UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL RETURNING id", [keyId, orgId]);
  if (!r) throw notFound("api key");
  await audit(pool(), ctx, "apikey.revoked", "api_key", keyId, {}, orgId);
  return { revoked: true };
}

export interface ApiKeyAuth {
  keyId: string;
  orgId: string;
  scopes: string[];
  createdBy: string | null;
}

/** Authenticate `Authorization: Bearer lk_…` for server-to-server calls. */
export async function authenticateApiKey(header: string | null, needed: ApiKeyScope): Promise<ApiKeyAuth> {
  const parsed = parseApiKey(header);
  if (!parsed) throw new ApiError(401, "invalid_api_key", "유효한 API 키가 필요합니다.");
  const k = await one<{ id: string; organization_id: string; scopes: string[]; created_by: string | null; revoked_at: Date | null; expires_at: Date | null; last_used_at: Date | null }>(
    "SELECT id, organization_id, scopes, created_by, revoked_at, expires_at, last_used_at FROM api_keys WHERE key_hash=$1",
    [sha256(parsed.key)],
  );
  if (!k || k.revoked_at || (k.expires_at && k.expires_at < new Date())) throw new ApiError(401, "invalid_api_key", "API 키가 만료되었거나 폐기되었습니다.");
  if (!hasApiScope(k.scopes, needed)) throw new ApiError(403, "insufficient_scope", `이 요청에는 ${needed} scope 가 필요합니다.`);
  await rateLimit(`apikey:${k.id}`, Number(process.env.API_KEY_RATE_LIMIT ?? 600), 60);
  if (!k.last_used_at || Date.now() - k.last_used_at.getTime() > 60_000) await q("UPDATE api_keys SET last_used_at=now() WHERE id=$1", [k.id]);
  return { keyId: k.id, orgId: k.organization_id, scopes: k.scopes, createdBy: k.created_by };
}

export async function apiListContacts(auth: ApiKeyAuth, opts: { kind: "contacts" | "leads"; limit?: number; updatedSince?: string | null }) {
  const params: unknown[] = [auth.orgId];
  let where = "c.organization_id=$1 AND c.scope='org' AND c.deleted_at IS NULL AND c.merged_into_id IS NULL";
  if (opts.kind === "leads") where += " AND c.ownership='company'";
  if (opts.updatedSince) {
    params.push(new Date(opts.updatedSince));
    where += ` AND c.updated_at > $${params.length}`;
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 100, 500)));
  const rows = await q<any>(
    `SELECT c.id, c.full_name, co.name AS company, c.job_title, c.email, c.phone, c.ownership, c.owner_user_id, u.display_name AS owner_name, c.updated_at
     FROM contacts c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN users u ON u.id=c.owner_user_id
     WHERE ${where} ORDER BY c.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  await audit(pool(), { userId: null }, "apikey.read", "api_key", auth.keyId, { kind: opts.kind, rows: rows.length }, auth.orgId);
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, company: r.company, jobTitle: r.job_title, email: r.email, phone: r.phone, ownership: r.ownership, owner: { userId: r.owner_user_id, name: r.owner_name }, updatedAt: r.updated_at }));
}

export async function apiCreateLead(auth: ApiKeyAuth, input: z.infer<typeof contactInput>) {
  return tx(async (c) => {
    // 담당자: key creator if still an active member, else the longest-standing owner
    const owner = await one<{ user_id: string }>(
      `SELECT user_id FROM organization_members WHERE organization_id=$1 AND status='active' AND role IN ('owner','admin','manager','member')
       ORDER BY (user_id = $2) DESC, CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
      [auth.orgId, auth.createdBy],
      c,
    );
    if (!owner) throw unavailable("no_assignee");
    const ids = await insertContact(c, owner.user_id, { ...input, source: "import" });
    await c.query("UPDATE contacts SET organization_id=$2, scope='org', ownership='company', shared_at=now() WHERE id=$1", [ids.contactId, auth.orgId]);
    // F-139 CRM sync required: queue the push (a missing CRM connection is recorded, never drops the lead)
    const crm = await enqueueRequiredCrmSync(c, ids.contactId);
    await audit(c, { userId: null }, "apikey.lead_created", "contact", ids.contactId, { keyId: auth.keyId, ...(crm.required ? { crm_sync: crm.violation ?? (crm.queued ? "queued" : "exists") } : {}) }, auth.orgId);
    return { id: ids.contactId, ownerUserId: owner.user_id };
  });
}

// ---------- F-008 SSO (OIDC) ----------
export const ssoConfigInput = z.object({
  issuer: z.string().url().max(300),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().max(500).nullish(),
  enabled: z.boolean().default(false),
  defaultRole: z.enum(["manager", "member", "viewer"]).default("member"),
});

export async function saveSsoConfig(ctx: Ctx, orgId: string, input: z.infer<typeof ssoConfigInput>) {
  const issuer = input.issuer.replace(/\/$/, "");
  if (!/^https:\/\//.test(issuer) && process.env.SSO_ALLOW_HTTP_ISSUER !== "1") throw badRequest("issuer_must_be_https");
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "sso.manage", c);
    await c.query(
      `INSERT INTO sso_configs (organization_id, issuer, client_id, encrypted_client_secret, enabled, default_role) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id) DO UPDATE SET issuer=EXCLUDED.issuer, client_id=EXCLUDED.client_id,
         encrypted_client_secret=COALESCE(EXCLUDED.encrypted_client_secret, sso_configs.encrypted_client_secret), enabled=EXCLUDED.enabled,
         default_role=EXCLUDED.default_role, updated_at=now()`,
      [orgId, issuer, input.clientId, input.clientSecret ? seal({ secret: input.clientSecret }) : null, input.enabled, input.defaultRole],
    );
    await audit(c, ctx, "sso.config_saved", "organization", orgId, { issuer, enabled: input.enabled }, orgId);
    return getSsoConfigInternal(orgId, c);
  });
}

async function getSsoConfigInternal(orgId: string, db: Db) {
  const r = await one<any>("SELECT issuer, client_id, enabled, default_role, encrypted_client_secret IS NOT NULL AS has_secret, scim_token_hash IS NOT NULL AS has_scim FROM sso_configs WHERE organization_id=$1", [orgId], db);
  const o = await one<{ slug: string; sso_required: boolean }>("SELECT slug, sso_required FROM organizations WHERE id=$1", [orgId], db);
  const saml = await one<{ enabled: boolean; has_scim: boolean }>("SELECT enabled, scim_token_hash IS NOT NULL AS has_scim FROM saml_configs WHERE organization_id=$1", [orgId], db);
  return {
    configured: Boolean(r),
    issuer: r?.issuer ?? null,
    clientId: r?.client_id ?? null,
    enabled: r?.enabled ?? false,
    defaultRole: r?.default_role ?? "member",
    hasClientSecret: r?.has_secret ?? false,
    scimEnabled: Boolean(r?.has_scim || saml?.has_scim),
    redirectUri: `${appOrigin()}/api/v1/auth/sso/callback`,
    loginUrl: `${appOrigin()}/api/v1/auth/sso/start?org=${o?.slug ?? ""}`,
    scimBaseUrl: `${appOrigin()}/scim/v2`,
    saml: { configured: Boolean(saml), enabled: saml?.enabled ?? false },
    /** org policy: verified-domain users must use SSO (owners keep e-mail OTP as break-glass) */
    ssoRequired: o?.sso_required ?? false,
  };
}

export async function getSsoConfig(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "sso.manage");
  return getSsoConfigInternal(orgId, pool());
}

export async function rotateScimToken(ctx: Ctx, orgId: string) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "sso.manage", c);
    const token = `scim_${generateToken(32)}`;
    // the token lives on the OIDC config when there is one, otherwise on the SAML config; the other copy is cleared
    let r = await c.query("UPDATE sso_configs SET scim_token_hash=$2, updated_at=now() WHERE organization_id=$1", [orgId, sha256(token)]);
    if (r.rowCount) await c.query("UPDATE saml_configs SET scim_token_hash=NULL WHERE organization_id=$1", [orgId]);
    else r = await c.query("UPDATE saml_configs SET scim_token_hash=$2, updated_at=now() WHERE organization_id=$1", [orgId, sha256(token)]);
    if (!r.rowCount) throw badRequest("sso_not_configured", "먼저 SSO(OIDC 또는 SAML) 설정을 저장하세요.");
    await audit(c, ctx, "scim.token_rotated", "organization", orgId, {}, orgId);
    return { token };
  });
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const discoveryCache = new Map<string, { at: number; d: Discovery }>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.d;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) throw new ApiError(502, "sso_discovery_failed", "SSO 공급자(OIDC discovery)에 연결할 수 없습니다.");
  const d = (await res.json()) as Discovery;
  if (d.issuer?.replace(/\/$/, "") !== issuer) throw new ApiError(502, "sso_issuer_mismatch");
  discoveryCache.set(issuer, { at: Date.now(), d });
  return d;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** GET /auth/sso/start?org=slug | ?email=… → redirect URL to the org's IdP (PKCE S256 + nonce + one-time state). */
export async function ssoStart(
  ctx: Ctx,
  opts: { org?: string | null; email?: string | null; next?: string | null; consent?: boolean; browserBinding?: string | null; referralCode?: string | null },
) {
  await rateLimit(`sso:start:${ctx.ip}`, 30, 600);
  type Found = { id: string; oidc: boolean };
  const pick = `SELECT o.id, EXISTS (SELECT 1 FROM sso_configs s WHERE s.organization_id=o.id AND s.enabled) AS oidc FROM organizations o`;
  let org: Found | null = null;
  if (opts.org) org = await one<Found>(`${pick} WHERE o.slug=$1 AND ${SSO_AVAILABLE_SQL}`, [opts.org]);
  else if (opts.email) {
    const d = emailDomain(normalizeEmail(opts.email) ?? "");
    if (d) org = await one<Found>(`${pick} WHERE $1 = ANY(o.verified_domains) AND ${SSO_AVAILABLE_SQL} LIMIT 1`, [d]);
  }
  if (!org) throw notFound("sso");
  // OIDC wins when both connections are enabled; otherwise SAML 2.0 (SP-initiated, HTTP-Redirect)
  if (!org.oidc) return samlStart(ctx, org.id, { next: opts.next, consent: opts.consent, browserBinding: opts.browserBinding, referralCode: opts.referralCode });
  const cfg = await one<{ issuer: string; client_id: string }>("SELECT issuer, client_id FROM sso_configs WHERE organization_id=$1", [org.id]);
  const disc = await discover(cfg!.issuer);
  const state = generateToken(32);
  const nonce = generateToken(16);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await q("INSERT INTO sso_login_states (state_hash, organization_id, nonce, code_verifier, next_path, expires_at, referral_code) VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes', $6)", [
    sha256(state),
    org.id,
    nonce,
    verifier,
    opts.next ?? null,
    isReferralCode(opts.referralCode) ? opts.referralCode : null, // F-064
  ]);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg!.client_id,
    redirect_uri: `${appOrigin()}/api/v1/auth/sso/callback`,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(opts.email ? { login_hint: opts.email } : {}),
  });
  return { url: `${disc.authorization_endpoint}?${params}`, orgId: org.id };
}

/**
 * Callback: one-time state → code exchange (PKCE) → id_token verified against the IdP JWKS (iss, aud, exp, nonce) →
 * email must be on one of the org's verified domains → user upsert (consents required for new accounts) → membership → session.
 */
export async function ssoCallback(ctx: Ctx, input: { code: string; state: string; consents: { type: ConsentType; granted: boolean }[] }) {
  const st = await one<{ id: string; organization_id: string; nonce: string; code_verifier: string; next_path: string | null; expires_at: Date; consumed_at: Date | null; referral_code: string | null }>(
    "UPDATE sso_login_states SET consumed_at=now() WHERE state_hash=$1 AND consumed_at IS NULL RETURNING *",
    [sha256(input.state)],
  );
  if (!st || st.expires_at < new Date()) throw badRequest("invalid_state", "SSO 로그인 요청이 만료되었거나 이미 사용되었습니다.");
  const cfg = await one<{ issuer: string; client_id: string; encrypted_client_secret: Buffer | null; enabled: boolean; default_role: OrgRole }>(
    "SELECT issuer, client_id, encrypted_client_secret, enabled, default_role FROM sso_configs WHERE organization_id=$1",
    [st.organization_id],
  );
  if (!cfg?.enabled) throw notFound("sso");
  const disc = await discover(cfg.issuer);
  const secret = cfg.encrypted_client_secret ? unseal<{ secret: string }>(cfg.encrypted_client_secret).secret : null;
  const res = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: `${appOrigin()}/api/v1/auth/sso/callback`,
      client_id: cfg.client_id,
      code_verifier: st.code_verifier,
      ...(secret ? { client_secret: secret } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) throw new ApiError(502, "sso_token_failed", "SSO 토큰 교환에 실패했습니다.");
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw new ApiError(502, "sso_no_id_token");
  let claims: { sub?: string; email?: string; email_verified?: boolean; name?: string; nonce?: string };
  try {
    const { payload } = await jwtVerify(tok.id_token, createRemoteJWKSet(new URL(disc.jwks_uri)), { issuer: cfg.issuer, audience: cfg.client_id, clockTolerance: 60 });
    claims = payload as typeof claims;
  } catch (e) {
    log("warn", "sso.id_token_invalid", { error: (e as Error).message });
    throw new ApiError(401, "sso_invalid_token", "SSO 신원 토큰 검증에 실패했습니다.");
  }
  if (claims.nonce !== st.nonce) throw new ApiError(401, "sso_nonce_mismatch");
  const email = normalizeEmail(claims.email ?? "");
  if (!email || claims.email_verified === false || !claims.sub) throw new ApiError(401, "sso_email_missing", "SSO 공급자가 확인된 이메일을 주지 않았습니다.");
  await assertOrgEmailDomain(st.organization_id, email);
  const r = await tx((c) =>
    completeSsoLogin(c, ctx, {
      orgId: st.organization_id,
      email,
      name: claims.name,
      provider: `oidc:${st.organization_id}`,
      subject: claims.sub!,
      consents: input.consents,
      defaultRole: cfg.default_role,
      method: "oidc_sso",
      referralCode: st.referral_code,
    }),
  );
  return { ...r, next: st.next_path };
}

// ---------- F-008 SCIM 2.0 ----------
const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export class ScimError extends Error {
  constructor(public status: number, public detail: string, public scimType?: string) {
    super(detail);
  }
  toJSON() {
    return { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(this.status), detail: this.detail, ...(this.scimType ? { scimType: this.scimType } : {}) };
  }
}

export async function scimAuth(header: string | null): Promise<string> {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !token.startsWith("scim_")) throw new ScimError(401, "SCIM bearer token required");
  const r = await one<{ organization_id: string }>(
    "SELECT organization_id FROM sso_configs WHERE scim_token_hash=$1 UNION ALL SELECT organization_id FROM saml_configs WHERE scim_token_hash=$1 LIMIT 1",
    [sha256(token)],
  );
  if (!r) throw new ScimError(401, "invalid SCIM token");
  await rateLimit(`scim:${r.organization_id}`, 1200, 60).catch(() => {
    throw new ScimError(429, "too many requests");
  });
  return r.organization_id;
}

function scimUser(r: { id: string; email: string | null; display_name: string | null; status: string; joined_at: Date; external_id: string | null }) {
  return {
    schemas: [SCIM_USER],
    id: r.id,
    externalId: r.external_id ?? undefined,
    userName: r.email,
    name: { formatted: r.display_name ?? undefined },
    displayName: r.display_name ?? undefined,
    emails: r.email ? [{ value: r.email, primary: true, type: "work" }] : [],
    active: r.status === "active",
    meta: { resourceType: "User", created: r.joined_at, location: `${appOrigin()}/scim/v2/Users/${r.id}` },
  };
}

const SCIM_SELECT = `u.id, u.email, u.display_name, m.status, m.joined_at,
  (SELECT i.provider_subject FROM identities i WHERE i.user_id=u.id AND i.provider = 'scim:' || m.organization_id::text LIMIT 1) AS external_id`;

export async function scimList(orgId: string, opts: { filter?: string | null; startIndex?: number; count?: number }) {
  const params: unknown[] = [orgId];
  let where = "m.organization_id=$1 AND m.status IN ('active','removed')";
  if (opts.filter) {
    const f = opts.filter.match(/^\s*(userName|externalId|emails\.value)\s+eq\s+"([^"]+)"\s*$/i);
    if (!f) throw new ScimError(400, "unsupported filter", "invalidFilter");
    params.push(f[1]!.toLowerCase() === "externalid" ? f[2] : f[2]!.toLowerCase());
    where += f[1]!.toLowerCase() === "externalid" ? ` AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider='scim:' || m.organization_id::text AND i.provider_subject=$2)` : ` AND lower(u.email)=$2`;
  }
  const start = Math.max(1, opts.startIndex ?? 1);
  const count = Math.max(0, Math.min(200, opts.count ?? 100));
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id=m.user_id WHERE ${where}`, params);
  const rows = await q<any>(`SELECT ${SCIM_SELECT} FROM organization_members m JOIN users u ON u.id=m.user_id WHERE ${where} ORDER BY m.joined_at, u.id OFFSET ${start - 1} LIMIT ${count}`, params);
  return { schemas: [SCIM_LIST], totalResults: total!.n, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(scimUser) };
}

async function scimGetInternal(orgId: string, userId: string, db: Db = pool()) {
  if (!z.string().uuid().safeParse(userId).success) throw new ScimError(404, "User not found");
  const r = await one<any>(`SELECT ${SCIM_SELECT} FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status IN ('active','removed')`, [orgId, userId], db);
  if (!r) throw new ScimError(404, "User not found");
  return scimUser(r);
}

export const scimGet = (orgId: string, id: string) => scimGetInternal(orgId, id);

const scimUserInput = z.object({
  userName: z.string().min(3).max(200),
  externalId: z.string().max(200).optional(),
  active: z.boolean().default(true),
  displayName: z.string().max(200).optional(),
  name: z.object({ formatted: z.string().max(200).optional(), givenName: z.string().max(100).optional(), familyName: z.string().max(100).optional() }).optional(),
  emails: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })).optional(),
});

function scimDisplayName(b: z.infer<typeof scimUserInput>): string | null {
  return b.displayName ?? b.name?.formatted ?? ([b.name?.familyName, b.name?.givenName].filter(Boolean).join("") || null);
}

/** POST /scim/v2/Users — provision: create (or link) the account and an active membership. No consents are recorded:
 * the person must still accept terms at first sign-in (identity.upsertUserByEmail enforces it for scim-provisioned users). */
export async function scimCreate(orgId: string, body: unknown) {
  const p = scimUserInput.safeParse(body);
  if (!p.success) throw new ScimError(400, "invalid user payload", "invalidValue");
  const b = p.data;
  const email = normalizeEmail(b.emails?.find((e) => e.primary)?.value ?? b.emails?.[0]?.value ?? b.userName);
  if (!email) throw new ScimError(400, "userName must be an email", "invalidValue");
  const org = await one<{ verified_domains: string[] }>("SELECT verified_domains FROM organizations WHERE id=$1", [orgId]);
  if (!org!.verified_domains.includes(emailDomain(email)!)) throw new ScimError(400, "email domain is not a verified domain of this organization", "invalidValue");
  return tx(async (c) => {
    let u = await one<{ id: string }>("SELECT id FROM users WHERE email=$1", [email], c);
    const existing = u ? await one<{ status: string }>("SELECT status FROM organization_members WHERE organization_id=$1 AND user_id=$2", [orgId, u.id], c) : null;
    if (existing?.status === "active") throw new ScimError(409, "User already exists", "uniqueness");
    if (!u) u = await one<{ id: string }>("INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id", [email, scimDisplayName(b)], c);
    await c.query("INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1,$2,$3) ON CONFLICT (provider, provider_subject) DO NOTHING", [u!.id, `scim:${orgId}`, b.externalId ?? email]);
    const role =
      (await one<{ default_role: OrgRole }>("SELECT default_role FROM sso_configs WHERE organization_id=$1 UNION ALL SELECT default_role FROM saml_configs WHERE organization_id=$1 LIMIT 1", [orgId], c))
        ?.default_role ?? "member";
    await c.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, join_source) VALUES ($1,$2,$3,$4,'scim')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET status=EXCLUDED.status, join_source='scim', joined_at=now(), left_at=NULL`,
      [orgId, u!.id, role, b.active ? "active" : "removed"],
    );
    await audit(c, { userId: null }, "scim.user_provisioned", "user", u!.id, { active: b.active }, orgId);
    return scimGetInternal(orgId, u!.id, c);
  });
}

async function scimSetActive(c: pg.PoolClient, orgId: string, userId: string, active: boolean) {
  const m = await one<{ status: string }>("SELECT status FROM organization_members WHERE organization_id=$1 AND user_id=$2 FOR UPDATE", [orgId, userId], c);
  if (!m) throw new ScimError(404, "User not found");
  if (!active && m.status === "active") {
    // deprovisioning: company-owned leads are reassigned, personal shared contacts leave with the person
    const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND role='owner' AND status='active' AND user_id<>$2", [orgId, userId], c);
    const isOwner = await one("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND role='owner'", [orgId, userId], c);
    if (isOwner && !owners!.n) throw new ScimError(409, "cannot deactivate the last owner", "mutability");
    await handleMemberDeparture(c, orgId, userId, null, { userId: null }, "scim_deprovisioned");
  } else if (active && m.status !== "active") {
    await c.query("UPDATE organization_members SET status='active', left_at=NULL, joined_at=now() WHERE organization_id=$1 AND user_id=$2", [orgId, userId]);
  }
}

export async function scimReplace(orgId: string, userId: string, body: unknown) {
  const p = scimUserInput.safeParse(body);
  if (!p.success) throw new ScimError(400, "invalid user payload", "invalidValue");
  return tx(async (c) => {
    await scimGetInternal(orgId, userId, c);
    const dn = scimDisplayName(p.data);
    if (dn) await c.query("UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1", [userId, dn]);
    await scimSetActive(c, orgId, userId, p.data.active);
    await audit(c, { userId: null }, "scim.user_replaced", "user", userId, { active: p.data.active }, orgId);
    return scimGetInternal(orgId, userId, c);
  });
}

export async function scimPatch(orgId: string, userId: string, body: any) {
  if (!Array.isArray(body?.Operations) || !(body.schemas ?? []).includes(SCIM_PATCH)) throw new ScimError(400, "PatchOp required", "invalidSyntax");
  return tx(async (c) => {
    await scimGetInternal(orgId, userId, c);
    for (const op of body.Operations as { op: string; path?: string; value?: any }[]) {
      const kind = String(op.op).toLowerCase();
      if (kind !== "replace" && kind !== "add") throw new ScimError(400, `unsupported op ${op.op}`, "invalidSyntax");
      const values: Record<string, any> = op.path ? { [op.path]: op.value } : (op.value ?? {});
      for (const [k, v] of Object.entries(values)) {
        if (k === "active") await scimSetActive(c, orgId, userId, v === true || v === "true" || v === "True");
        else if (k === "displayName" || k === "name.formatted") await c.query("UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1", [userId, String(v).slice(0, 200)]);
        else if (k === "name" && v?.formatted) await c.query("UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1", [userId, String(v.formatted).slice(0, 200)]);
      }
    }
    await audit(c, { userId: null }, "scim.user_patched", "user", userId, { ops: body.Operations.length }, orgId);
    return scimGetInternal(orgId, userId, c);
  });
}

/** DELETE removes the org membership (deprovision). The person's own LINKOS account and personal data are not deleted. */
export async function scimDelete(orgId: string, userId: string) {
  await tx(async (c) => {
    await scimGetInternal(orgId, userId, c);
    await scimSetActive(c, orgId, userId, false);
    await audit(c, { userId: null }, "scim.user_deleted", "user", userId, {}, orgId);
  });
}

export function scimServiceProviderConfig() {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Per-organization SCIM token" }],
  };
}

