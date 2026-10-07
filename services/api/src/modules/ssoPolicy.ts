// F-008 B2B SSO enforcement (org policy `sso_required`). Kept free of identity/org imports so identity and passkey
// can call it without import cycles. Decision logic lives in @linkos/domain (ssoEnforcementDecision).
import { type LoginMethod, type OrgRole, emailDomain, ssoEnforcementDecision } from "@linkos/domain";
import { type Db, one } from "../lib/db";
import { ApiError } from "../lib/errors";
import { log } from "../lib/platform";

/** SQL predicate: org `o` has at least one enabled SSO connection (OIDC or SAML). */
export const SSO_AVAILABLE_SQL = `(EXISTS (SELECT 1 FROM sso_configs s WHERE s.organization_id=o.id AND s.enabled)
  OR EXISTS (SELECT 1 FROM saml_configs s WHERE s.organization_id=o.id AND s.enabled))`;

export function ssoStartPath(orgSlug: string): string {
  return `/api/v1/auth/sso/start?org=${encodeURIComponent(orgSlug)}`;
}

/**
 * Throws 403 `sso_required` (details.ssoUrl = the company SSO start path, no PII) when `email` belongs to a verified
 * domain of an org that enforces SSO and `method` is not allowed. Break-glass: active owners may still use e-mail OTP.
 */
export async function assertSsoAllowed(db: Db, email: string, method: LoginMethod): Promise<void> {
  const d = emailDomain(email);
  if (!d) return;
  const org = await one<{ id: string; slug: string; verified_domains: string[]; sso_available: boolean }>(
    `SELECT o.id, o.slug, o.verified_domains, ${SSO_AVAILABLE_SQL} AS sso_available
     FROM organizations o WHERE o.sso_required AND $1 = ANY(o.verified_domains) LIMIT 1`,
    [d],
    db,
  );
  if (!org) return;
  const m = await one<{ role: OrgRole }>(
    "SELECT m.role FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND u.email=$2 AND m.status='active'",
    [org.id, email],
    db,
  );
  const decision = ssoEnforcementDecision({ ssoRequired: true, ssoAvailable: org.sso_available, email, verifiedDomains: org.verified_domains, role: m?.role ?? null, method });
  if (decision === "allow") return;
  log("info", "auth.sso_required", { org: org.id, method });
  throw new ApiError(403, "sso_required", "이 회사 계정은 회사 SSO로만 로그인할 수 있습니다.", { ssoUrl: ssoStartPath(org.slug), org: org.slug });
}
