// F-008 B2B SSO — the steps shared by every SSO protocol (OIDC callback, SAML ACS) after the IdP's assertion has
// been verified: verified-domain gate → user link/create (consent for new or SCIM-provisioned accounts) → membership
// (SCIM stays the source of truth when the org uses it) → session tagged with the SSO method.
import { type ConsentType, type LoginMethod, type OrgRole, emailDomain } from "@linkos/domain";
import type pg from "pg";
import { type Db, one, pool } from "../lib/db";
import { ApiError } from "../lib/errors";
import { type Ctx, audit } from "../lib/platform";
import { assertSeatAvailable } from "./billing";
import { createSession, upsertUserByEmail } from "./identity";
import { attributeSignupByCodeTx } from "./referral";

/** Only e-mails on one of the org's verified domains may sign in through that org's IdP. */
export async function assertOrgEmailDomain(orgId: string, email: string, db: Db = pool()): Promise<void> {
  const org = await one<{ verified_domains: string[] }>("SELECT verified_domains FROM organizations WHERE id=$1", [orgId], db);
  const d = emailDomain(email);
  if (!org || !d || !org.verified_domains.length || !org.verified_domains.includes(d)) {
    throw new ApiError(403, "sso_domain_not_allowed", "이 조직의 인증된 도메인 이메일만 SSO로 로그인할 수 있습니다.");
  }
}

export async function orgUsesScim(orgId: string, db: Db): Promise<boolean> {
  return Boolean(
    await one(
      `SELECT 1 FROM sso_configs WHERE organization_id=$1 AND scim_token_hash IS NOT NULL
       UNION ALL SELECT 1 FROM saml_configs WHERE organization_id=$1 AND scim_token_hash IS NOT NULL LIMIT 1`,
      [orgId],
      db,
    ),
  );
}

export interface SsoIdentity {
  orgId: string;
  email: string;
  name?: string | null;
  /** identities.provider, e.g. `oidc:<orgId>` / `saml:<orgId>` */
  provider: string;
  subject: string;
  consents: { type: ConsentType; granted: boolean }[];
  defaultRole: OrgRole;
  method: Extract<LoginMethod, "oidc_sso" | "saml_sso">;
  /** F-064 /r/{code} captured at SSO start (NEW accounts only) */
  referralCode?: string | null;
}

export async function completeSsoLogin(c: pg.PoolClient, ctx: Ctx, id: SsoIdentity): Promise<{ sessionToken: string; userId: string; isNew: boolean }> {
  const { user, isNew } = await upsertUserByEmail(c, id.email, id.consents, id.name ?? undefined, id.provider, id.subject);
  const m = await one<{ status: string }>("SELECT status FROM organization_members WHERE organization_id=$1 AND user_id=$2", [id.orgId, user.id], c);
  if (m && m.status !== "active" && (await orgUsesScim(id.orgId, c))) {
    // deprovisioned through SCIM (or removed by an admin) — SSO must not silently re-add the membership
    throw new ApiError(403, "sso_deprovisioned", "조직에서 비활성화된 계정입니다. 회사 관리자에게 문의하세요.");
  }
  if (m?.status !== "active") {
    // F-191: just-in-time SSO membership takes a seat like an invite/domain join/SCIM provisioning does
    await c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [id.orgId]);
    await assertSeatAvailable(id.orgId, c);
    await c.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, join_source) VALUES ($1,$2,$3,'active','sso')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET status='active', role=EXCLUDED.role, join_source='sso', joined_at=now(), left_at=NULL`,
      [id.orgId, user.id, id.defaultRole],
    );
  }
  await c.query("UPDATE users SET active_org_id=COALESCE(active_org_id,$2) WHERE id=$1", [user.id, id.orgId]);
  const sessionToken = await createSession(c, user.id, ctx, null, "web", id.method);
  await audit(c, { userId: user.id }, isNew ? "auth.signup" : "auth.login", "user", user.id, { method: id.method }, id.orgId);
  if (isNew) await attributeSignupByCodeTx(c, user.id, id.referralCode); // F-064
  return { sessionToken, userId: user.id, isNew };
}
