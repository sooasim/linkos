// F-001 회원가입/로그인 · F-060 One Tap 가입 — Sign in with Apple (web) against a local fake Apple with locally generated keys.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppleUser, type AuthorizeOpts, type FakeApple, startFakeApple } from "./fakeApple";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");

let fake: FakeApple;
const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { apple, identity, one, q, closePool } = api;
const ctx = () => ({ userId: null, ip: "10.7.7.7", userAgent: "Mozilla/5.0 (iPhone) Safari/605.1", requestId: "t" });
let seq = 0;
const sub = () => `000${Date.now()}.${++seq}.apple`;

/** start → (user at Apple) → form_post fields */
async function viaApple(user: AppleUser, opts: AuthorizeOpts & { next?: string; consentAccepted?: boolean } = {}) {
  const { url } = await apple.appleAuthStart(ctx(), { next: opts.next ?? "/app", consentAccepted: opts.consentAccepted });
  return fake.authorize(url, user, opts);
}

beforeAll(async () => {
  fake = await startFakeApple();
  process.env.APPLE_API_BASE = fake.url;
  process.env.APPLE_CLIENT_ID = fake.clientId;
  process.env.APPLE_TEAM_ID = fake.teamId;
  process.env.APPLE_KEY_ID = fake.keyId;
  process.env.APPLE_PRIVATE_KEY = fake.privateKeyPem.replace(/\n/g, "\\n"); // single-line env form
  await migrate();
});
afterAll(async () => {
  await fake.close();
  await closePool();
});

describe("F-060 Sign in with Apple", () => {
  it("is off unless fully configured", async () => {
    const saved = process.env.APPLE_KEY_ID;
    delete process.env.APPLE_KEY_ID;
    expect(apple.appleEnabled()).toBe(false);
    await expect(apple.appleAuthStart(ctx(), {})).rejects.toMatchObject({ status: 503, code: "apple_not_configured" });
    process.env.APPLE_KEY_ID = saved;
    expect(apple.appleEnabled()).toBe(true);
  });

  it("authorize URL: form_post, scope name email, one-time state stored only as a hash, nonce", async () => {
    const { url } = await apple.appleAuthStart(ctx(), { next: "/claim" });
    const p = new URL(url).searchParams;
    expect(url.startsWith(`${fake.url}/auth/authorize?`)).toBe(true);
    expect(Object.fromEntries(p)).toMatchObject({ response_type: "code", response_mode: "form_post", scope: "name email", client_id: fake.clientId, redirect_uri: "https://linkos.test/api/v1/auth/apple/callback" });
    const state = p.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(43); // ≥ 256 bits base64url
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(22);
    expect(await one("SELECT 1 FROM apple_login_states WHERE state_hash=$1", [state])).toBeNull();
    expect(await one("SELECT next_path FROM apple_login_states WHERE state_hash=$1", [api.sha256(state)])).toEqual({ next_path: "/claim" });
  });

  it("new user: consent gate first (name parked), then signup with the parked name; client secret is an ES256 JWT", async () => {
    const s = sub();
    const email = `apple${seq}@example.io`;
    const user: AppleUser = { sub: s, email, name: { firstName: "민지", lastName: "박" } };
    const first = await viaApple(user, { firstLogin: true, next: "/claim" });
    expect(first.user).toContain("민지");
    await expect(apple.appleCallback(ctx(), first)).rejects.toMatchObject({ status: 422, code: "consent_required", details: { next: "/claim" } });
    expect(await one("SELECT 1 FROM users WHERE email=$1", [email])).toBeNull(); // nothing created before consent
    const secret = fake.tokenCalls.at(-1)!;
    expect(secret.ok).toBe(true);
    expect(secret.secretHeader).toMatchObject({ alg: "ES256", kid: fake.keyId });
    expect(secret.secretClaims).toMatchObject({ iss: fake.teamId, sub: fake.clientId, aud: "https://appleid.apple.com" });

    // user accepted the consents on /login?consent=apple → new attempt; Apple no longer sends the name
    const second = await viaApple(user, { consentAccepted: true, next: "/claim" });
    expect(second.user).toBeUndefined();
    const r = await apple.appleCallback(ctx(), second);
    expect(r).toMatchObject({ isNew: true, next: "/claim", privateEmail: false });
    const u = await one<{ display_name: string; email: string }>("SELECT display_name, email FROM users WHERE id=$1", [r.userId]);
    expect(u).toEqual({ display_name: "박민지", email });
    expect(await one("SELECT 1 FROM identities WHERE user_id=$1 AND provider='apple' AND provider_subject=$2", [r.userId, s])).toBeTruthy();
    const consents = await q<{ consent_type: string }>("SELECT consent_type FROM consent_records WHERE subject_user_id=$1 AND granted ORDER BY consent_type", [r.userId]);
    expect(consents.map((c) => c.consent_type)).toEqual(["age_14", "privacy", "terms"]);
    expect(await one("SELECT 1 FROM apple_pending_profiles WHERE subject_hash=$1", [api.sha256(`apple:${s}`)])).toBeNull();
    expect(await identity.resolveSession(r.sessionToken, ctx())).toMatchObject({ userId: r.userId });
    const a = await one<{ metadata: Record<string, unknown> }>("SELECT metadata FROM audit_logs WHERE actor_user_id=$1 AND action='auth.signup'", [r.userId]);
    expect(a!.metadata).toMatchObject({ method: "apple", private_email: false });
    expect(JSON.stringify(a)).not.toContain(email); // no raw email in audit metadata

    // returning user: no consent needed, same account
    const again = await apple.appleCallback(ctx(), await viaApple({ sub: s, email }));
    expect(again).toMatchObject({ userId: r.userId, isNew: false });
  });

  it("links to an existing account with the same verified email (OTP user)", async () => {
    const email = `otp-apple${Date.now()}@example.io`;
    const { devCode } = await identity.requestOtp(ctx(), email);
    const existing = (await identity.verifyOtp(ctx(), email, devCode!, ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true })))).user;
    const r = await apple.appleCallback(ctx(), await viaApple({ sub: sub(), email: email.toUpperCase() }));
    expect(r).toMatchObject({ userId: existing.id, isNew: false });
  });

  it("private relay email (Hide My Email) is accepted as the account email", async () => {
    const relay = `x${Date.now()}q@privaterelay.appleid.com`;
    const r = await apple.appleCallback(ctx(), await viaApple({ sub: sub(), email: relay, isPrivateEmail: "true" }, { consentAccepted: true }));
    expect(r).toMatchObject({ isNew: true, privateEmail: true });
    expect(await one("SELECT email FROM users WHERE id=$1", [r.userId])).toEqual({ email: relay });
  });

  it("ES256-signed id_token (key chosen by kid from JWKS) is accepted", async () => {
    const r = await apple.appleCallback(ctx(), await viaApple({ sub: sub(), email: `ec${Date.now()}@example.io` }, { alg: "ES256", consentAccepted: true }));
    expect(r.isNew).toBe(true);
  });

  it("rejects wrong audience, wrong issuer, wrong nonce, expired token and an unknown signing key", async () => {
    const u = () => ({ sub: sub(), email: `bad${Date.now()}${seq}@example.io` });
    await expect(apple.appleCallback(ctx(), await viaApple(u(), { aud: "com.evil.app", consentAccepted: true }))).rejects.toMatchObject({ code: "apple_invalid_token" });
    await expect(apple.appleCallback(ctx(), await viaApple(u(), { iss: "https://appleid.apple.com.evil", consentAccepted: true }))).rejects.toMatchObject({ code: "apple_invalid_token" });
    await expect(apple.appleCallback(ctx(), await viaApple(u(), { nonce: "not-the-nonce", consentAccepted: true }))).rejects.toMatchObject({ code: "apple_nonce_mismatch" });
    await expect(apple.appleCallback(ctx(), await viaApple(u(), { expiresInSec: -3600, consentAccepted: true }))).rejects.toMatchObject({ code: "apple_token_expired" });
    await expect(apple.appleCallback(ctx(), await viaApple(u(), { signWithUnknownKey: true, consentAccepted: true }))).rejects.toMatchObject({ code: "apple_invalid_token" });
  });

  it("rejects a replayed or forged state, and a missing email for an unknown Apple subject", async () => {
    const form = await viaApple({ sub: sub(), email: `replay${Date.now()}@example.io` }, { consentAccepted: true });
    await apple.appleCallback(ctx(), form);
    await expect(apple.appleCallback(ctx(), form)).rejects.toMatchObject({ status: 400, code: "invalid_state" });
    await expect(apple.appleCallback(ctx(), { ...form, state: "forged-state-value-0000000000000000000000000" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(apple.appleCallback(ctx(), await viaApple({ sub: sub(), email: null }, { consentAccepted: true }))).rejects.toMatchObject({ code: "apple_email_missing" });
  });

  it("expired state is rejected even if unused", async () => {
    const form = await viaApple({ sub: sub(), email: `late${Date.now()}@example.io` }, { consentAccepted: true });
    await q("UPDATE apple_login_states SET expires_at = now() - interval '1 minute' WHERE state_hash=$1", [api.sha256(form.state)]);
    await expect(apple.appleCallback(ctx(), form)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
