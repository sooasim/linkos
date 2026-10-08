// F-008 B2B SSO — SAML 2.0 service provider (per-org IdP), plus the org policy `sso_required`.
//
// Flow: /auth/sso/start → samlStart(): AuthnRequest (HTTP-Redirect, deflate+base64) whose ID is stored once in
// saml_requests, bound to a signed one-time RelayState (+ a browser-binding cookie on https) →
// IdP POSTs to /sso/saml/{orgId}/acs → samlAcs(): XML-DSig of the Response or Assertion is verified by
// @node-saml/node-saml (xml-crypto; signed-reference extraction, single-assertion rule — no hand-rolled DSig) against
// the org's configured cert(s); Audience, NotBefore/NotOnOrAfter (±60s), InResponseTo, SubjectConfirmation are checked
// by the library and Issuer, Destination, Recipient, InResponseTo == stored request (consumed atomically) here →
// verified-domain gate → same user link/create + consent + membership path as OIDC (ssoLogin.ts).
import { X509Certificate, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CacheProvider,
  type Profile,
  SAML,
  ValidateInResponseTo,
  generateServiceProviderMetadata,
} from "@node-saml/node-saml";
import {
  type ConsentType,
  type OrgRole,
  SAML_NAMEID_FORMATS,
  extractSamlIdentity,
  generateToken,
  normalizeEmail,
  parseIdpMetadata,
  samlResponseRootAttributes,
  splitPemCerts,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { type Ctx, appOrigin, audit, hmac, log, rateLimit, sha256 } from "../lib/platform";
import { requireOrg } from "./org";
import { isReferralCode } from "./referral";
import { assertOrgEmailDomain, completeSsoLogin } from "./ssoLogin";
import { SSO_AVAILABLE_SQL } from "./ssoPolicy";

const CLOCK_SKEW_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_CERTS = 4;
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const REQUIRED_CONSENTS: { type: ConsentType; granted: boolean }[] = (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true }));

export function spUrls(orgId: string) {
  const base = `${appOrigin()}/api/v1/sso/saml/${orgId}`;
  return { entityId: `${base}/metadata`, metadataUrl: `${base}/metadata`, acsUrl: `${base}/acs` };
}

interface SamlConfigRow {
  idp_entity_id: string;
  sso_url: string;
  idp_certs: string[];
  name_id_format: string;
  email_attribute: string | null;
  name_attribute: string | null;
  enabled: boolean;
  default_role: OrgRole;
  has_scim: boolean;
  updated_at: Date;
}

async function loadConfig(orgId: string, db: Db = pool()): Promise<SamlConfigRow | null> {
  if (!z.string().uuid().safeParse(orgId).success) return null;
  return one<SamlConfigRow>(
    `SELECT idp_entity_id, sso_url, idp_certs, name_id_format, email_attribute, name_attribute, enabled, default_role,
       scim_token_hash IS NOT NULL AS has_scim, updated_at FROM saml_configs WHERE organization_id=$1`,
    [orgId],
    db,
  );
}

function certInfo(pem: string) {
  const c = new X509Certificate(pem);
  const notAfter = new Date(c.validTo);
  return { fingerprint256: c.fingerprint256, subject: c.subject.replace(/\n/g, ", "), notBefore: new Date(c.validFrom).toISOString(), notAfter: notAfter.toISOString(), expired: notAfter.getTime() < Date.now() };
}

// ---------- configuration (admin) ----------
export const samlConfigInput = z.object({
  /** IdP metadata XML; fills entityID / SSO URL / certs that are not given explicitly */
  metadataXml: z.string().max(200_000).nullish(),
  idpEntityId: z.string().trim().max(500).nullish(),
  ssoUrl: z.string().trim().max(1000).nullish(),
  /** one or more PEM certificates (rotation: paste old + new); omitted = keep the saved ones */
  certificates: z.string().max(40_000).nullish(),
  nameIdFormat: z.enum(SAML_NAMEID_FORMATS).default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
  emailAttribute: z.string().trim().max(300).nullish(),
  nameAttribute: z.string().trim().max(300).nullish(),
  enabled: z.boolean().default(false),
  defaultRole: z.enum(["manager", "member", "viewer"]).default("member"),
});

function validUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "https:" || (p.protocol === "http:" && process.env.SSO_ALLOW_HTTP_ISSUER === "1");
  } catch {
    return false;
  }
}

export async function saveSamlConfig(ctx: Ctx, orgId: string, input: z.infer<typeof samlConfigInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "sso.manage", c);
    const prev = await loadConfig(orgId, c);
    const md = input.metadataXml ? parseIdpMetadata(input.metadataXml) : null;
    if (input.metadataXml && !md?.entityId) throw badRequest("saml_metadata_invalid", "IdP 메타데이터에서 entityID를 찾지 못했습니다.");
    const entityId = input.idpEntityId || md?.entityId || prev?.idp_entity_id;
    const ssoUrl = input.ssoUrl || md?.ssoUrl || prev?.sso_url;
    if (!entityId) throw badRequest("saml_entity_id_required", "IdP Entity ID가 필요합니다.");
    if (!ssoUrl || !validUrl(ssoUrl)) throw badRequest("saml_sso_url_invalid", "IdP SSO URL(HTTP-Redirect, https)이 필요합니다.");
    let certs: string[];
    if (input.certificates) {
      certs = splitPemCerts(input.certificates);
      if (!certs.length) throw badRequest("saml_cert_invalid", "X.509 인증서(PEM)를 확인하세요.");
    } else certs = md?.certs.length ? md.certs : (prev?.idp_certs ?? []);
    if (!certs.length) throw badRequest("saml_cert_required", "IdP 서명 인증서가 필요합니다.");
    if (certs.length > MAX_CERTS) throw badRequest("saml_too_many_certs", `인증서는 최대 ${MAX_CERTS}개까지 등록할 수 있습니다.`);
    const infos = certs.map((pem) => {
      try {
        return certInfo(pem);
      } catch {
        throw badRequest("saml_cert_invalid", "X.509 인증서를 해석할 수 없습니다.");
      }
    });
    await c.query(
      `INSERT INTO saml_configs (organization_id, idp_entity_id, sso_url, idp_certs, name_id_format, email_attribute, name_attribute, enabled, default_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id) DO UPDATE SET idp_entity_id=EXCLUDED.idp_entity_id, sso_url=EXCLUDED.sso_url, idp_certs=EXCLUDED.idp_certs,
         name_id_format=EXCLUDED.name_id_format, email_attribute=EXCLUDED.email_attribute, name_attribute=EXCLUDED.name_attribute,
         enabled=EXCLUDED.enabled, default_role=EXCLUDED.default_role, updated_at=now()`,
      [orgId, entityId, ssoUrl, certs, input.nameIdFormat, input.emailAttribute || null, input.nameAttribute || null, input.enabled, input.defaultRole],
    );
    await audit(c, ctx, "sso.saml_config_saved", "organization", orgId, { idpEntityId: entityId, enabled: input.enabled, certs: infos.map((i) => i.fingerprint256) }, orgId);
    return samlConfigView(orgId, c);
  });
}

async function samlConfigView(orgId: string, db: Db) {
  const r = await loadConfig(orgId, db);
  const sp = spUrls(orgId);
  return {
    configured: Boolean(r),
    enabled: r?.enabled ?? false,
    idpEntityId: r?.idp_entity_id ?? null,
    ssoUrl: r?.sso_url ?? null,
    certificates: (r?.idp_certs ?? []).map((pem) => ({ pem, ...certInfo(pem) })),
    nameIdFormat: r?.name_id_format ?? SAML_NAMEID_FORMATS[0],
    emailAttribute: r?.email_attribute ?? null,
    nameAttribute: r?.name_attribute ?? null,
    defaultRole: r?.default_role ?? "member",
    sp: { entityId: sp.entityId, acsUrl: sp.acsUrl, metadataUrl: sp.metadataUrl, nameIdFormat: r?.name_id_format ?? SAML_NAMEID_FORMATS[0] },
  };
}

export async function getSamlConfig(ctx: Ctx, orgId: string) {
  await requireOrg(orgId, ctx.userId, "sso.manage");
  return samlConfigView(orgId, pool());
}

/** Public SP metadata (EntityDescriptor) for the org — what the IdP admin imports. */
export async function spMetadata(orgId: string): Promise<string> {
  if (!z.string().uuid().safeParse(orgId).success || !(await one("SELECT 1 FROM organizations WHERE id=$1", [orgId]))) throw notFound("sso");
  const cfg = await loadConfig(orgId);
  const sp = spUrls(orgId);
  return generateServiceProviderMetadata({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    identifierFormat: cfg?.name_id_format ?? SAML_NAMEID_FORMATS[0],
    wantAssertionsSigned: true,
  });
}

// ---------- SP-initiated login ----------
function samlClient(cfg: SamlConfigRow, orgId: string, opts: { requestId?: string; pending?: { id: string; createdAt: Date } }): SAML {
  const sp = spUrls(orgId);
  // Request IDs live in saml_requests (one-time, consumed in samlAcs). The library only needs to see the single
  // pending ID that this RelayState is bound to; everything else is "unknown request".
  const cacheProvider: CacheProvider = {
    saveAsync: async (_key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (opts.pending && key === opts.pending.id ? opts.pending.createdAt.toISOString() : null),
    removeAsync: async () => null,
  };
  return new SAML({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    entryPoint: cfg.sso_url,
    idpCert: cfg.idp_certs,
    idpIssuer: cfg.idp_entity_id,
    audience: sp.entityId,
    identifierFormat: cfg.name_id_format,
    // either the Response or the Assertion must carry a valid signature by one of the configured certs
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: REQUEST_TTL_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider,
    generateUniqueId: () => opts.requestId ?? `_${randomBytes(20).toString("hex")}`,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256",
  });
}

const relaySig = (token: string) => hmac(`saml-relay:${token}`).slice(0, 32);

function verifyRelayState(relay: string | null | undefined): string | null {
  if (!relay || relay.length > 200) return null;
  const [token, sig] = relay.split(".");
  if (!token || !sig || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const want = Buffer.from(relaySig(token));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? token : null;
}

/** Returns the IdP redirect URL (HTTP-Redirect binding). `browserBinding` is a random value the caller also sets as a cookie. */
export async function samlStart(ctx: Ctx, orgId: string, opts: { next?: string | null; consent?: boolean; browserBinding?: string | null; referralCode?: string | null } = {}) {
  await rateLimit(`sso:saml:start:${ctx.ip}`, 30, 600);
  const cfg = await loadConfig(orgId);
  if (!cfg?.enabled) throw notFound("sso");
  const requestId = `_${randomBytes(20).toString("hex")}`;
  const token = generateToken(32);
  const relayState = `${token}.${relaySig(token)}`;
  await q(
    `INSERT INTO saml_requests (organization_id, request_id, relay_state_hash, next_path, consent_accepted, browser_binding_hash, expires_at, referral_code)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes', $7)`,
    // F-064: the /r/{code} referral rides with the request (the ACS POST is cross-site: no Lax cookies)
    [orgId, requestId, sha256(token), opts.next ?? null, opts.consent === true, opts.browserBinding ? sha256(opts.browserBinding) : null, isReferralCode(opts.referralCode) ? opts.referralCode : null],
  );
  if (Math.random() < 0.02) void q("DELETE FROM saml_requests WHERE expires_at < now() - interval '1 day'").catch(() => undefined);
  const url = await samlClient(cfg, orgId, { requestId }).getAuthorizeUrlAsync(relayState, undefined, {});
  return { url, orgId };
}

// ---------- ACS (HTTP-POST binding) ----------
const invalid = (reason: string, orgId: string) => {
  log("warn", "sso.saml_rejected", { org: orgId, reason });
  return new ApiError(401, "saml_invalid_response", "회사 SSO(SAML) 응답을 확인하지 못했습니다.");
};

type XmlJs = { $?: Record<string, string>; [k: string]: unknown };

/** Bearer SubjectConfirmation(s) of the verified assertion must name our ACS as Recipient and our request as InResponseTo. */
function subjectConfirmationOk(profile: Profile, acsUrl: string, requestId: string): boolean {
  const a = (profile.getAssertion?.() as { Assertion?: XmlJs } | undefined)?.Assertion;
  const subject = (a?.Subject as XmlJs[] | undefined)?.[0];
  const scs = ((subject?.SubjectConfirmation as XmlJs[] | undefined) ?? []).filter((sc) => sc.$?.Method === BEARER);
  if (!scs.length) return false;
  return scs.every((sc) => {
    const d = (sc.SubjectConfirmationData as XmlJs[] | undefined)?.[0]?.$;
    return Boolean(d && d.Recipient === acsUrl && (!d.InResponseTo || d.InResponseTo === requestId));
  });
}

export async function samlAcs(
  ctx: Ctx,
  input: { orgId: string; samlResponse: string | null; relayState: string | null; browserBinding?: string | null },
): Promise<{ sessionToken: string; userId: string; isNew: boolean; next: string | null }> {
  await rateLimit(`sso:saml:acs:${ctx.ip}`, 60, 600);
  const { orgId } = input;
  const cfg = await loadConfig(orgId);
  if (!cfg?.enabled) throw notFound("sso");
  const token = verifyRelayState(input.relayState);
  if (!token) throw badRequest("invalid_state", "SSO 로그인 요청이 만료되었거나 이미 사용되었습니다.");
  const req = await one<{ id: string; request_id: string; next_path: string | null; consent_accepted: boolean; browser_binding_hash: string | null; created_at: Date; expires_at: Date; consumed_at: Date | null; referral_code: string | null }>(
    "SELECT id, request_id, next_path, consent_accepted, browser_binding_hash, created_at, expires_at, consumed_at, referral_code FROM saml_requests WHERE relay_state_hash=$1 AND organization_id=$2",
    [sha256(token), orgId],
  );
  if (!req || req.expires_at < new Date()) throw badRequest("invalid_state", "SSO 로그인 요청이 만료되었거나 이미 사용되었습니다.");
  if (req.consumed_at) {
    log("warn", "sso.saml_replay", { org: orgId });
    throw new ApiError(401, "saml_replayed", "이미 사용된 SSO 응답입니다. 다시 로그인하세요.");
  }
  if (req.browser_binding_hash && (!input.browserBinding || sha256(input.browserBinding) !== req.browser_binding_hash)) {
    throw new ApiError(401, "saml_browser_mismatch", "로그인을 시작한 브라우저에서 다시 시도하세요.");
  }
  if (!input.samlResponse || input.samlResponse.length > 600_000) throw invalid("missing_or_oversized", orgId);

  let profile: Profile | null;
  try {
    profile = (await samlClient(cfg, orgId, { pending: { id: req.request_id, createdAt: req.created_at } }).validatePostResponseAsync({ SAMLResponse: input.samlResponse })).profile;
  } catch (e) {
    throw invalid((e as Error).message.slice(0, 160), orgId);
  }
  if (!profile) throw invalid("no_profile", orgId);
  const sp = spUrls(orgId);
  if (profile.inResponseTo !== req.request_id) throw invalid("in_response_to", orgId);
  if (profile.issuer !== cfg.idp_entity_id) throw invalid("issuer", orgId);
  const root = samlResponseRootAttributes(profile.getSamlResponseXml?.() ?? "");
  if (!root || (root.Destination !== undefined && root.Destination !== sp.acsUrl)) throw invalid("destination", orgId);
  if (!subjectConfirmationOk(profile, sp.acsUrl, req.request_id)) throw invalid("recipient", orgId);

  // one-time: the stored request is consumed exactly once (a replayed response finds it consumed)
  const consumed = await one("UPDATE saml_requests SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id", [req.id]);
  if (!consumed) throw new ApiError(401, "saml_replayed", "이미 사용된 SSO 응답입니다. 다시 로그인하세요.");

  const ident = extractSamlIdentity(
    { nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, attributes: (profile.attributes as Record<string, unknown> | undefined) ?? null },
    { emailAttribute: cfg.email_attribute, nameAttribute: cfg.name_attribute },
  );
  const email = normalizeEmail(ident.email ?? "");
  if (!email) throw new ApiError(401, "sso_email_missing", "SSO 공급자가 이메일을 주지 않았습니다.");
  await assertOrgEmailDomain(orgId, email);
  const r = await tx((c) =>
    completeSsoLogin(c, ctx, {
      orgId,
      email,
      name: ident.name,
      provider: `saml:${orgId}`,
      subject: ident.subject ?? email,
      consents: req.consent_accepted ? REQUIRED_CONSENTS : [],
      defaultRole: cfg.default_role,
      method: "saml_sso",
      referralCode: req.referral_code,
    }),
  );
  return { ...r, next: req.next_path };
}

// ---------- org policy: sso_required ----------
export const ssoEnforcementInput = z.object({ ssoRequired: z.boolean() });

/**
 * Admin-only. Enabling requires an enabled SSO connection and a verified domain, and revokes every non-SSO session
 * (OTP / Google / passkey / pre-existing) of users on the org's verified domains. Owners are exempt (break-glass OTP).
 */
export async function setSsoRequired(ctx: Ctx, orgId: string, input: z.infer<typeof ssoEnforcementInput>) {
  return tx(async (c) => {
    await requireOrg(orgId, ctx.userId, "sso.manage", c);
    const o = await one<{ verified_domains: string[]; sso_required: boolean; sso_available: boolean }>(
      `SELECT o.verified_domains, o.sso_required, ${SSO_AVAILABLE_SQL} AS sso_available FROM organizations o WHERE o.id=$1 FOR UPDATE`,
      [orgId],
      c,
    );
    if (input.ssoRequired && (!o!.sso_available || !o!.verified_domains.length)) {
      throw badRequest("sso_not_configured", "SSO 강제를 켜려면 사용 중인 SSO 연결(OIDC 또는 SAML)과 인증된 도메인이 필요합니다.");
    }
    await c.query("UPDATE organizations SET sso_required=$2, sso_required_changed_at=now(), updated_at=now() WHERE id=$1", [orgId, input.ssoRequired]);
    let revoked: { user_id: string }[] = [];
    if (input.ssoRequired) {
      const r = await c.query<{ user_id: string }>(
        `UPDATE auth_sessions s SET revoked_at=now() FROM users u
         WHERE u.id=s.user_id AND s.revoked_at IS NULL AND s.expires_at > now()
           AND (s.auth_method IS NULL OR s.auth_method NOT IN ('oidc_sso','saml_sso'))
           AND lower(split_part(u.email,'@',2)) = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=$1 AND m.user_id=u.id AND m.role='owner' AND m.status='active')
         RETURNING s.user_id`,
        [orgId, o!.verified_domains],
      );
      revoked = r.rows;
    }
    const usersAffected = new Set(revoked.map((r) => r.user_id)).size;
    await audit(c, ctx, "org.sso_required_changed", "organization", orgId, { ssoRequired: input.ssoRequired, sessionsRevoked: revoked.length, usersAffected }, orgId);
    return { ssoRequired: input.ssoRequired, sessionsRevoked: revoked.length, usersAffected };
  });
}
