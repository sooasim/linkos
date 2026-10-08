// F-008 B2B SSO — SAML 2.0 SP + SSO enforcement (sso_required) integration tests on real PostgreSQL.
// The IdP is simulated in-process: self-signed signing certs built with node:crypto, Responses signed with xml-crypto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantSeats } from "./seats";
import { type IdpKey, type ResponseOpts, b64, buildResponse, idpMetadataXml, makeIdpKey, readAuthnRequest, signXml } from "./fakeSamlIdp";
import { createSoftAuthenticator } from "./softAuthenticator";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_g";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.LLM_DISABLED = "1";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { enterprise, identity, org, passkey, saml, closePool, q, one, tx } = api;

type Ctx = { userId: string | null; ip: string; userAgent: string; requestId: string };
const ctx = (userId: string | null): Ctx => ({ userId, ip: "10.0.0.7", userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; status?: number }) => e.code ?? String(e.status));
async function signUp(email: string, name?: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return identity.verifyOtp(ctx(null), email, devCode!, consents, name);
}

const IDP = "https://idp.saml-corp.io/entity";
const IDP_SSO = "https://idp.saml-corp.io/sso/redirect";
let k1: IdpKey, k2: IdpKey, kOther: IdpKey;
let owner: { id: string };
let ownerToken: string;
let orgId: string;
let slug: string;
let sp: { entityId: string; acsUrl: string; metadataUrl: string };

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, audit_logs, rate_limits, otp_codes, webauthn_challenges CASCADE");
  k1 = makeIdpKey("idp-2025");
  k2 = makeIdpKey("idp-2026");
  kOther = makeIdpKey("attacker");
  const o = await signUp("owner@saml-corp.io", "대표");
  owner = o.user;
  ownerToken = o.sessionToken;
  const created = await org.createOrg(ctx(owner.id), { name: "SAML Corp" });
  orgId = created.id;
  await grantSeats(orgId, 20, "enterprise");
  slug = created.slug;
  await org.addDomain(ctx(owner.id), orgId, "saml-corp.io");
  sp = saml.spUrls(orgId);
});
afterAll(async () => {
  await closePool();
});

async function start(opts: { consent?: boolean; email?: string } = {}) {
  const s = await enterprise.ssoStart(ctx(null), { email: opts.email ?? "someone@saml-corp.io", next: "/app/org", consent: opts.consent ?? true });
  return { url: s.url, req: readAuthnRequest(s.url) };
}
const response = (req: { id: string }, over: Partial<ResponseOpts> = {}) =>
  buildResponse({ issuer: IDP, inResponseTo: req.id, recipient: sp.acsUrl, audience: sp.entityId, nameId: "kim@saml-corp.io", key: k1, attributes: { displayName: "김사원" }, ...over });
const acs = (relayState: string, xml: string) => saml.samlAcs(ctx(null), { orgId, samlResponse: b64(xml), relayState });

// ---------------------------------------------------------------------------------------------
describe("F-008 SAML configuration + SP metadata", () => {
  it("imports IdP metadata, validates certs/URLs, exposes SP Entity ID / ACS / metadata URL", async () => {
    expect(await code(saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ idpEntityId: IDP, ssoUrl: "http://idp.saml-corp.io/sso", certificates: k1.certPem })))).toBe("saml_sso_url_invalid");
    expect(await code(saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ idpEntityId: IDP, ssoUrl: IDP_SSO, certificates: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" })))).toBe("saml_cert_invalid");
    expect(await code(saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ idpEntityId: IDP, ssoUrl: IDP_SSO })))).toBe("saml_cert_required");
    expect(await code(saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ metadataXml: "<html/>" })))).toBe("saml_metadata_invalid");

    const cfg = await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ metadataXml: idpMetadataXml(IDP, IDP_SSO, [k1]), enabled: true }));
    expect(cfg).toMatchObject({ configured: true, enabled: true, idpEntityId: IDP, ssoUrl: IDP_SSO, defaultRole: "member" });
    expect(cfg.certificates).toHaveLength(1);
    expect(cfg.certificates[0]!.fingerprint256.replace(/:/g, "").toLowerCase()).toBe(k1.fingerprint);
    expect(cfg.certificates[0]!.expired).toBe(false);
    expect(cfg.sp).toMatchObject({ entityId: `https://linkos.test/api/v1/sso/saml/${orgId}/metadata`, acsUrl: `https://linkos.test/api/v1/sso/saml/${orgId}/acs` });
    expect(await one("SELECT 1 FROM audit_logs WHERE action='sso.saml_config_saved' AND organization_id=$1", [orgId])).toBeTruthy();
    expect((await enterprise.getSsoConfig(ctx(owner.id), orgId)).saml).toEqual({ configured: true, enabled: true });

    const md = await saml.spMetadata(orgId);
    expect(md).toContain(`entityID="${sp.entityId}"`);
    expect(md).toMatch(new RegExp(`AssertionConsumerService[^>]+Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]+Location="${sp.acsUrl.replace(/[.?]/g, "\\$&")}"`));
    expect(md).toContain('WantAssertionsSigned="true"');
    expect(await code(saml.spMetadata("00000000-0000-0000-0000-000000000000"))).toBe("not_found");
    expect(await code(saml.getSamlConfig(ctx(null), orgId))).toBe("unauthorized");
  });

  it("SP-initiated AuthnRequest uses HTTP-Redirect (deflate+base64) with a signed one-time RelayState", async () => {
    const { url, req } = await start();
    expect(url.startsWith(`${IDP_SSO}?SAMLRequest=`)).toBe(true);
    expect(req.acs).toBe(sp.acsUrl);
    expect(req.destination).toBe(IDP_SSO);
    expect(req.issuer).toBe(sp.entityId);
    expect(req.id).toMatch(/^_[0-9a-f]{40}$/);
    expect(req.relayState).toMatch(/^[A-Za-z0-9_-]{40,}\.[0-9a-f]{32}$/);
    const row = await one<{ request_id: string; relay_state_hash: string }>("SELECT request_id, relay_state_hash FROM saml_requests WHERE request_id=$1", [req.id]);
    expect(row!.relay_state_hash).not.toContain(req.relayState.split(".")[0]); // only the hash is stored
    // org selection by slug works too
    expect((await enterprise.ssoStart(ctx(null), { org: slug })).url.startsWith(IDP_SSO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-008 SAML ACS — login", () => {
  it("valid signed assertion: consent step for new users, then account + membership + SSO session", async () => {
    let { req } = await start({ consent: false });
    expect(await code(acs(req.relayState, response(req)))).toBe("consent_required");
    ({ req } = await start({ consent: true }));
    const r = await acs(req.relayState, response(req));
    expect(r).toMatchObject({ isNew: true, next: "/app/org" });
    expect((await identity.resolveSession(r.sessionToken, ctx(null)))?.userId).toBe(r.userId);
    expect(await one("SELECT role, status, join_source FROM organization_members WHERE organization_id=$1 AND user_id=$2", [orgId, r.userId])).toEqual({ role: "member", status: "active", join_source: "sso" });
    expect(await one("SELECT display_name, email FROM users WHERE id=$1", [r.userId])).toEqual({ display_name: "김사원", email: "kim@saml-corp.io" });
    expect(await one("SELECT auth_method FROM auth_sessions WHERE user_id=$1", [r.userId])).toEqual({ auth_method: "saml_sso" });
    expect(await one("SELECT 1 FROM identities WHERE user_id=$1 AND provider=$2 AND provider_subject='kim@saml-corp.io'", [r.userId, `saml:${orgId}`])).toBeTruthy();
    expect(await one("SELECT 1 FROM audit_logs WHERE action='auth.signup' AND metadata->>'method'='saml_sso' AND organization_id=$1", [orgId])).toBeTruthy();
  });

  it("accepts a signature on the Response instead of the Assertion", async () => {
    const { req } = await start();
    const r = await acs(req.relayState, response(req, { sign: "response" }));
    expect(r.isNew).toBe(false);
  });

  it("rejects wrong audience, expired / not-yet-valid, unsigned, other cert, wrong issuer, destination, recipient, foreign InResponseTo and tampering", async () => {
    const past = (m: number) => new Date(Date.now() - m * 60_000);
    const future = (m: number) => new Date(Date.now() + m * 60_000);
    const other = await start();
    const cases: [string, (req: { id: string }) => string][] = [
      ["wrong audience", (req) => response(req, { audience: "https://other-sp.example/metadata" })],
      ["expired", (req) => response(req, { notBefore: past(20), notOnOrAfter: past(5) })],
      ["not yet valid", (req) => response(req, { notBefore: future(10), notOnOrAfter: future(20) })],
      ["unsigned", (req) => response(req, { sign: "none" })],
      ["signed by another cert", (req) => response(req, { key: kOther })],
      ["response signed by another cert", (req) => response(req, { key: kOther, sign: "response" })],
      ["wrong issuer", (req) => response(req, { issuer: "https://evil-idp.example" })],
      ["wrong destination", (req) => response(req, { destination: "https://other-sp.example/acs" })],
      ["wrong recipient", (req) => response(req, { recipient: "https://other-sp.example/acs", destination: sp.acsUrl })],
      ["InResponseTo of another request", () => response(other.req)],
      ["tampered after signing", (req) => response(req).replace("kim@saml-corp.io", "owner@saml-corp.io")],
    ];
    for (const [label, make] of cases) {
      const { req } = await start();
      expect([label, await code(acs(req.relayState, make(req)))]).toEqual([label, "saml_invalid_response"]);
      // a rejected response does not burn the request, and never creates a session
      expect(await one("SELECT consumed_at FROM saml_requests WHERE request_id=$1", [req.id])).toEqual({ consumed_at: null });
    }
    expect(await one("SELECT count(*)::int AS n FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.email='owner@saml-corp.io' AND s.auth_method='saml_sso'")).toEqual({ n: 0 });
  });

  it("rejects a replayed response (InResponseTo is one-time) and a forged RelayState", async () => {
    const { req } = await start();
    const xml = response(req);
    await acs(req.relayState, xml);
    expect(await code(acs(req.relayState, xml))).toBe("saml_replayed");
    // same response with a fresh RelayState → its InResponseTo no longer matches the pending request
    const fresh = await start();
    expect(await code(acs(fresh.req.relayState, xml))).toBe("saml_invalid_response");
    const [tok] = fresh.req.relayState.split(".");
    expect(await code(acs(`${tok}.${"0".repeat(32)}`, response(fresh.req)))).toBe("invalid_state");
    expect(await code(acs("garbage", response(fresh.req)))).toBe("invalid_state");
    // RelayState of another org's request
    expect(await code(saml.samlAcs(ctx(null), { orgId: "00000000-0000-0000-0000-000000000000", samlResponse: b64(response(fresh.req)), relayState: fresh.req.relayState }))).toBe("not_found");
  });

  it("login-CSRF: a request bound to a browser cookie is only accepted from that browser", async () => {
    const s = await enterprise.ssoStart(ctx(null), { org: slug, consent: true, browserBinding: "binding-value-of-the-starting-browser" });
    const req = readAuthnRequest(s.url);
    const xml = response(req);
    const post = (browserBinding: string | null) => saml.samlAcs(ctx(null), { orgId, samlResponse: b64(xml), relayState: req.relayState, browserBinding });
    expect(await code(post(null))).toBe("saml_browser_mismatch");
    expect(await code(post("attacker-browser"))).toBe("saml_browser_mismatch");
    expect((await post("binding-value-of-the-starting-browser")).userId).toBeTruthy();
  });

  it("rejects XML signature wrapping (signed assertion moved aside, forged assertion in its place)", async () => {
    const { req } = await start();
    // the IdP legitimately signs an assertion for an ordinary employee …
    const signed = response(req, { nameId: "intern@saml-corp.io" });
    const original = signed.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)![0];
    // … the attacker keeps the signature but swaps the identity in a copy with a new ID
    const forged = original.replace(/ID="(_a[0-9a-f]+)"/, 'ID="_forged"').replace(/intern@saml-corp\.io/g, "owner@saml-corp.io");
    const variants = [
      signed.replace(original, `<samlp:Extensions>${original}</samlp:Extensions>${forged}`),
      signed.replace(original, `${forged}`).replace("</samlp:Response>", `<samlp:Extensions>${original}</samlp:Extensions></samlp:Response>`),
      signed.replace(original, `${original}${forged}`), // two assertions
    ];
    for (const v of variants) expect(await code(acs(req.relayState, v))).toBe("saml_invalid_response");
    // a forged assertion wrapping the signed original inside its own Signature/Object
    const nested = forged.replace("</ds:Signature>", `<ds:Object>${original}</ds:Object></ds:Signature>`);
    expect(await code(acs(req.relayState, signed.replace(original, nested)))).toBe("saml_invalid_response");
    // and the honest response still works
    expect((await acs(req.relayState, signed)).isNew).toBe(true);
  });

  it("refuses e-mails outside the org's verified domains", async () => {
    const { req } = await start();
    expect(await code(acs(req.relayState, response(req, { nameId: "spy@elsewhere.io" })))).toBe("sso_domain_not_allowed");
    const { req: r2 } = await start();
    expect(await code(acs(r2.relayState, response(r2, { nameId: "opaque-123", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", attributes: {} })))).toBe("sso_email_missing");
  });

  it("attribute mapping: e-mail and name from configured attributes, persistent NameID as subject", async () => {
    await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ emailAttribute: "workEmail", nameAttribute: "fullName", enabled: true, nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" }));
    const { req } = await start();
    const r = await acs(req.relayState, response(req, { nameId: "emp-7781", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", attributes: { workEmail: "Lee@Saml-Corp.io", fullName: "이과장" } }));
    expect(await one("SELECT email, display_name FROM users WHERE id=$1", [r.userId])).toEqual({ email: "lee@saml-corp.io", display_name: "이과장" });
    expect(await one("SELECT 1 FROM identities WHERE user_id=$1 AND provider=$2 AND provider_subject='emp-7781'", [r.userId, `saml:${orgId}`])).toBeTruthy();
    await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ enabled: true }));
  });

  it("certificate rotation: both certs accepted during the overlap, the retired cert rejected afterwards", async () => {
    await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ certificates: `${k1.certPem}\n${k2.certPem}`, enabled: true }));
    for (const key of [k1, k2]) {
      const { req } = await start();
      expect((await acs(req.relayState, response(req, { key }))).userId).toBeTruthy();
    }
    const cfg = await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ certificates: k2.certPem, enabled: true }));
    expect(cfg.certificates.map((c) => c.fingerprint256.replace(/:/g, "").toLowerCase())).toEqual([k2.fingerprint]);
    const { req } = await start();
    expect(await code(acs(req.relayState, response(req, { key: k1 })))).toBe("saml_invalid_response");
    const { req: r2 } = await start();
    expect((await acs(r2.relayState, response(r2, { key: k2 }))).userId).toBeTruthy();
    // saving without certificates keeps the current ones
    expect((await saml.saveSamlConfig(ctx(owner.id), orgId, saml.samlConfigInput.parse({ enabled: true }))).certificates).toHaveLength(1);
    k1 = k2; // remaining tests sign with the active cert
  });

  it("SCIM interplay: SAML-only org gets a SCIM token; provisioned users accept terms at first SSO login; deprovisioned users are refused", async () => {
    const { token } = await enterprise.rotateScimToken(ctx(owner.id), orgId);
    expect(await enterprise.scimAuth(`Bearer ${token}`)).toBe(orgId);
    expect((await enterprise.getSsoConfig(ctx(owner.id), orgId)).scimEnabled).toBe(true);
    const created = await enterprise.scimCreate(orgId, { userName: "prov@saml-corp.io", externalId: "okta-9", active: true });
    let { req } = await start({ consent: false });
    expect(await code(acs(req.relayState, response(req, { nameId: "prov@saml-corp.io" })))).toBe("consent_required");
    ({ req } = await start({ consent: true }));
    const r = await acs(req.relayState, response(req, { nameId: "prov@saml-corp.io" }));
    expect(r).toMatchObject({ userId: created.id, isNew: false });
    await enterprise.scimPatch(orgId, created.id, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
    ({ req } = await start());
    expect(await code(acs(req.relayState, response(req, { nameId: "prov@saml-corp.io" })))).toBe("sso_deprovisioned");
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-008 SSO enforcement (sso_required)", () => {
  it("admin-only, requires an enabled SSO connection; enabling revokes non-SSO sessions of domain users (owners exempt)", async () => {
    // a member who signed up by e-mail OTP earlier and also registered a passkey
    const m = await signUp("member@saml-corp.io", "멤버");
    const auth = createSoftAuthenticator("https://linkos.test");
    await passkey.verifyRegistration(ctx(m.user.id), { response: auth.register(await passkey.registrationOptions(ctx(m.user.id))) as any });
    // the same person also has an SSO session
    const { req } = await start();
    const ssoLogin = await acs(req.relayState, response(req, { nameId: "member@saml-corp.io" }));
    expect(ssoLogin.userId).toBe(m.user.id);
    const outsider = await signUp("friend@gmail.com");
    const pendingCode = (await identity.requestOtp(ctx(null), "member@saml-corp.io")).devCode!;

    // permissions + preconditions
    expect(await code(saml.setSsoRequired(ctx(m.user.id), orgId, { ssoRequired: true }))).toBe("forbidden");
    const other = await signUp("boss@no-sso.io");
    const o2 = await org.createOrg(ctx(other.user.id), { name: "No SSO" });
    await org.addDomain(ctx(other.user.id), o2.id, "no-sso.io");
    expect(await code(saml.setSsoRequired(ctx(other.user.id), o2.id, { ssoRequired: true }))).toBe("sso_not_configured");

    const r = await saml.setSsoRequired(ctx(owner.id), orgId, { ssoRequired: true });
    expect(r.ssoRequired).toBe(true);
    expect(r.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await identity.resolveSession(m.sessionToken, ctx(null))).toBeNull(); // OTP session revoked
    expect((await identity.resolveSession(ssoLogin.sessionToken, ctx(null)))?.userId).toBe(m.user.id); // SSO session kept
    expect((await identity.resolveSession(ownerToken, ctx(null)))?.userId).toBe(owner.id); // owner exempt
    expect((await identity.resolveSession(outsider.sessionToken, ctx(null)))?.userId).toBe(outsider.user.id); // other domain
    expect(await one("SELECT metadata->>'ssoRequired' AS v FROM audit_logs WHERE action='org.sso_required_changed' AND organization_id=$1", [orgId])).toEqual({ v: "true" });
    expect((await enterprise.getSsoConfig(ctx(owner.id), orgId)).ssoRequired).toBe(true);

    // e-mail OTP refused (request and a code issued before enforcement), pointing at the company SSO
    const err = await identity.requestOtp(ctx(null), "member@saml-corp.io").catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: "sso_required", details: { ssoUrl: `/api/v1/auth/sso/start?org=${slug}` } });
    expect(await code(identity.verifyOtp(ctx(null), "member@saml-corp.io", pendingCode, consents))).toBe("sso_required");
    expect(await code(identity.requestOtp(ctx(null), "brand.new@saml-corp.io"))).toBe("sso_required");
    // Google (redirect callback and One Tap share upsertUserByEmail)
    expect(await code(tx((c) => identity.upsertUserByEmail(c, "member@saml-corp.io", [], undefined, "google", "g-1")))).toBe("sso_required");
    expect(await code(tx((c) => identity.upsertUserByEmail(c, "owner@saml-corp.io", [], undefined, "google", "g-2")))).toBe("sso_required");
    // passkey
    const lo = await passkey.authenticationOptions(ctx(null), "member@saml-corp.io");
    expect(await code(passkey.verifyAuthentication(ctx(null), { challengeId: lo.challengeId, response: auth.login({ challenge: lo.options.challenge, rpId: "linkos.test" }) as any }))).toBe("sso_required");
    // other domains unaffected
    expect(await code(identity.requestOtp(ctx(null), "friend@gmail.com"))).toBe("ok");
    // SSO itself still works
    const { req: r2 } = await start();
    expect((await acs(r2.relayState, response(r2, { nameId: "member@saml-corp.io" }))).userId).toBe(m.user.id);
  });

  it("break-glass: an org owner can still sign in with e-mail OTP", async () => {
    const { devCode } = await identity.requestOtp(ctx(null), "owner@saml-corp.io");
    const r = await identity.verifyOtp(ctx(null), "owner@saml-corp.io", devCode!, []);
    expect(r.user.id).toBe(owner.id);
    expect(await one("SELECT auth_method FROM auth_sessions WHERE refresh_hash=encode(sha256($1::bytea),'hex')", [r.sessionToken])).toEqual({ auth_method: "email_otp" });
  });

  it("turning enforcement off restores OTP", async () => {
    const r = await saml.setSsoRequired(ctx(owner.id), orgId, { ssoRequired: false });
    expect(r).toMatchObject({ ssoRequired: false, sessionsRevoked: 0 });
    expect(await code(identity.requestOtp(ctx(null), "member@saml-corp.io"))).toBe("ok");
  });
});
