// Track E integration tests (real PostgreSQL, DATABASE_URL=…/linkos_test_e):
// native bearer sessions, F-039/F-040 proximity, F-044 NFC tags, F-046 web rendezvous, F-052 offline receipts, F-060 One Tap.
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_e";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const domain = await import("@linkos/domain");
const { card, channels, handoff, identity, closePool, q, one } = api;

const ctx = (userId: string | null, ip = "10.0.0.5", ua = "Mozilla/5.0 (iPhone) Safari/605") => ({ userId, ip, userAgent: ua, requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
const baseProfile = {
  company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
  theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [],
};

async function signUp(email: string, name?: string, kind: "web" | "native" = "web") {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  const r = await identity.verifyOtp(ctx(null), email, devCode!, consents, undefined, kind);
  if (name) {
    await card.saveProfile(ctx(r.user.id), {
      ...baseProfile,
      name,
      company: `${name} Corp`,
      fields: [
        { type: "email", value: email, visibility: "business" },
        { type: "mobile", value: "010-0000-0000", visibility: "trusted" },
      ],
    });
  }
  return r;
}

let jwks: Server;
let jwksUrl = "";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, exchange_sessions, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes, events, nfc_tags, exchange_rendezvous, device_exchange_keys, offline_receipts CASCADE");
  jwks = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" });
    res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" }] }));
  });
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
});
afterAll(async () => {
  jwks?.close();
  await closePool();
});

describe("native bearer sessions (apps/mobile)", () => {
  it("binds tokens to their transport and rotates only explicitly", async () => {
    const web = await signUp("web-only@test.io");
    const nat = await identity.verifyOtp(ctx(null), "web-only@test.io", (await identity.requestOtp(ctx(null), "web-only@test.io")).devCode!, [], undefined, "native");
    // a cookie token is not a bearer token and vice versa
    expect(await identity.resolveSession(web.sessionToken, ctx(null), true, "native")).toBeNull();
    expect(await identity.resolveSession(nat.sessionToken, ctx(null))).toBeNull();
    const s = await identity.resolveSession(nat.sessionToken, ctx(null), true, "native");
    expect(s?.userId).toBe(web.user.id);
    expect(s?.rotatedToken).toBeUndefined();
    const kind = await one<{ client_kind: string; device_label: string }>("SELECT client_kind, device_label FROM auth_sessions WHERE refresh_hash=$1", [api.sha256(nat.sessionToken)]);
    expect(kind).toMatchObject({ client_kind: "native" });

    const r = await identity.refreshNativeSession(nat.sessionToken, ctx(null));
    expect(r.sessionToken).not.toBe(nat.sessionToken);
    expect((await identity.resolveSession(r.sessionToken, ctx(null), true, "native"))?.userId).toBe(web.user.id);
    // reuse of the rotated token → family revoked
    expect(await identity.resolveSession(nat.sessionToken, ctx(null), true, "native")).toBeNull();
    expect(await identity.resolveSession(r.sessionToken, ctx(null), true, "native")).toBeNull();
    await expect(identity.refreshNativeSession(r.sessionToken, ctx(null))).rejects.toMatchObject({ status: 401 });
  });
});

describe("F-060 Google One Tap (ID token verified against JWKS)", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function idToken(claims: Record<string, unknown>, key = privateKey, kid = "test-kid") {
    const head = b64({ alg: "RS256", kid, typ: "JWT" });
    const body = b64(claims);
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
    return `${head}.${body}.${sig}`;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const good = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: "client-123.apps.googleusercontent.com", sub: "g-sub-1", email: "onetap@test.io", email_verified: true, name: "원탭", iat: now(), exp: now() + 600, ...over });

  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
    process.env.GOOGLE_JWKS_URL = jwksUrl;
  });
  afterAll(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_JWKS_URL;
  });

  it("verifies signature, audience, issuer, expiry and email_verified", async () => {
    await expect(identity.verifyGoogleIdToken(idToken(good()))).resolves.toMatchObject({ sub: "g-sub-1", email: "onetap@test.io" });
    await expect(identity.verifyGoogleIdToken(idToken(good(), other.privateKey))).rejects.toMatchObject({ code: "invalid_google_credential" });
    await expect(identity.verifyGoogleIdToken(idToken(good({ aud: "someone-else" })))).rejects.toMatchObject({ code: "invalid_google_credential" });
    await expect(identity.verifyGoogleIdToken(idToken(good({ iss: "https://evil.example" })))).rejects.toMatchObject({ code: "invalid_google_credential" });
    await expect(identity.verifyGoogleIdToken(idToken(good({ exp: now() - 3600 })))).rejects.toMatchObject({ code: "google_credential_expired" });
    await expect(identity.verifyGoogleIdToken(idToken(good({ email_verified: false })))).rejects.toMatchObject({ code: "google_email_unverified" });
    await expect(identity.verifyGoogleIdToken(idToken(good(), privateKey, "unknown-kid"))).rejects.toMatchObject({ code: "invalid_google_credential" });
    const t = idToken(good());
    const [h, , s] = t.split(".");
    await expect(identity.verifyGoogleIdToken(`${h}.${b64(good({ email: "victim@test.io" }))}.${s}`)).rejects.toMatchObject({ code: "invalid_google_credential" });
    await expect(identity.verifyGoogleIdToken(`${b64({ alg: "none", kid: "test-kid" })}.${b64(good())}.`)).rejects.toMatchObject({ code: "invalid_google_credential" });
  });

  it("signs up with required consents, then signs in without them", async () => {
    await expect(identity.signInWithGoogleIdToken(ctx(null), idToken(good()), [])).rejects.toMatchObject({ code: "consent_required" });
    const first = await identity.signInWithGoogleIdToken(ctx(null), idToken(good()), consents);
    expect(first.isNew).toBe(true);
    expect((await identity.resolveSession(first.sessionToken, ctx(null)))?.userId).toBe(first.user.id);
    const again = await identity.signInWithGoogleIdToken(ctx(null), idToken(good()), []);
    expect(again.isNew).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    const ident = await one("SELECT 1 FROM identities WHERE provider='google' AND provider_subject='g-sub-1' AND user_id=$1", [first.user.id]);
    expect(ident).toBeTruthy();
    const audit = await one<{ metadata: { method: string } }>("SELECT metadata FROM audit_logs WHERE actor_user_id=$1 AND action='auth.signup'", [first.user.id]);
    expect(audit?.metadata.method).toBe("google_one_tap");
  });
});

describe("F-044 NFC accessory tags", () => {
  it("register → tap creates a fresh single-use session each time → revoke", async () => {
    const owner = await signUp("nfc-owner@test.io", "엔에프씨");
    const tag = await channels.registerNfcTag(ctx(owner.user.id), { label: "지갑 카드" });
    expect(tag.url).toBe(`https://linkos.test/n/${tag.tagId}`);
    expect(domain.isWellFormedToken(tag.tagId)).toBe(true);
    const stored = await one<{ tag_hash: string }>("SELECT tag_hash FROM nfc_tags WHERE id=$1", [tag.id]);
    expect(stored!.tag_hash).not.toContain(tag.tagId);

    const t1 = await channels.tapNfcTag(tag.tagId, ctx(null, "10.9.9.9"));
    const t2 = await channels.tapNfcTag(tag.tagId, ctx(null, "10.9.9.9"));
    expect(t1.url).not.toBe(t2.url);
    expect(t1.url).toMatch(/^https:\/\/linkos\.test\/x\//);
    const s1 = await one<{ max_uses: number; sender_user_id: string; state: string; channel_plan: string[] }>("SELECT max_uses, sender_user_id, state, channel_plan FROM exchange_sessions WHERE id=$1", [t1.sessionId]);
    expect(s1).toMatchObject({ max_uses: 1, sender_user_id: owner.user.id, state: "OFFERED" });
    expect(s1!.channel_plan[0]).toBe("nfc_accessory");
    expect(s1!.channel_plan.at(-1)).toBe("qr");
    const att = await one("SELECT 1 FROM exchange_attempts WHERE exchange_session_id=$1 AND channel='nfc_accessory' AND outcome='success'", [t1.sessionId]);
    expect(att).toBeTruthy();

    // the guest landing works without login and is single-use
    const token = t1.url.split("/x/")[1]!;
    const landing = await handoff.openGuestLanding(token, ctx(null, "10.9.9.9"), "anon");
    expect(landing.sender.name).toBe("엔에프씨");
    await handoff.replyExchange(token, ctx(null), { card: { fullName: "게스트" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} });
    await expect(handoff.replyExchange(token, ctx(null), { card: { fullName: "게스트2" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} })).rejects.toMatchObject({ code: "already_exchanged" });

    const listed = await channels.listNfcTags(owner.user.id);
    expect(listed[0]).toMatchObject({ label: "지갑 카드", use_count: 2 });

    // server adds the NFC rung to the owner's ladder automatically
    const sess = await handoff.createExchangeSession(ctx(owner.user.id), { capabilities: {}, group: false, context: {} });
    expect(sess.channelPlan).toContain("nfc_accessory");

    // other users cannot revoke it; owner can; revoked tags stop working
    const intruder = await signUp("nfc-intruder@test.io");
    await expect(channels.revokeNfcTag(ctx(intruder.user.id), tag.id)).rejects.toMatchObject({ status: 404 });
    await channels.revokeNfcTag(ctx(owner.user.id), tag.id);
    await expect(channels.tapNfcTag(tag.tagId, ctx(null))).rejects.toMatchObject({ code: "nfc_tag_revoked" });
    await expect(channels.tapNfcTag("not-a-real-tag-id-xxxxxxxxx", ctx(null))).rejects.toMatchObject({ status: 404 });
    const auditRows = await q<{ action: string }>("SELECT action FROM audit_logs WHERE entity_id=$1", [tag.id]);
    expect(auditRows.map((r) => r.action).sort()).toEqual(["nfc_tag.registered", "nfc_tag.revoked"]);
  });

  it("tap is rate limited per tag", async () => {
    const owner = await signUp("nfc-rl@test.io", "레이트");
    const tag = await channels.registerNfcTag(ctx(owner.user.id), { label: "스티커" });
    delete process.env.RATE_LIMIT_DISABLED;
    try {
      const hash = api.sha256(tag.tagId).slice(0, 24);
      await q("INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, to_timestamp(floor(extract(epoch from now())/600)*600), 30)", [`nfc:tap:${hash}`]);
      await expect(channels.tapNfcTag(tag.tagId, ctx(null, "10.1.1.1"))).rejects.toMatchObject({ status: 429 });
    } finally {
      process.env.RATE_LIMIT_DISABLED = "1";
    }
  });
});

describe("F-046 web-to-web rendezvous", () => {
  it("receiver listens → sender enters spoken code → sender confirms → receiver gets the link once", async () => {
    const sender = await signUp("rdv-sender@test.io", "센더");
    const sess = await handoff.createExchangeSession(ctx(sender.user.id), { capabilities: { receiverMode: "web_exchange_screen" }, group: false, context: {} });
    expect(sess.channelPlan[0]).toBe("web_rendezvous");

    const listen = await channels.startRendezvous(ctx(null, "10.2.2.2", "Mozilla/5.0 (Linux; Android 14) Chrome/130"));
    expect(listen.code).toMatch(/^\d{4}$/);
    expect(await channels.pollRendezvous(listen.listenToken, ctx(null))).toMatchObject({ status: "waiting", url: null, senderName: null });

    // wrong code → not found (and only a small budget of attempts)
    const wrong = listen.code === "0000" ? "1111" : "0000";
    await expect(channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, wrong)).rejects.toMatchObject({ code: "rendezvous_not_found" });
    // another user cannot drive someone else's session
    const mallory = await signUp("rdv-mallory@test.io", "말로리");
    await expect(channels.matchRendezvous(ctx(mallory.user.id), sess.sessionId, listen.code)).rejects.toMatchObject({ status: 404 });

    const m = await channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, listen.code);
    expect(m.receiverHint).toBe("Android · Chrome");
    expect(await channels.pollRendezvous(listen.listenToken, ctx(null))).toMatchObject({ status: "matched", senderName: "센더", url: null });
    // the same code cannot be matched twice
    await expect(channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, listen.code)).rejects.toMatchObject({ code: "rendezvous_not_found" });
    // confirming requires possession of the exchange token
    await expect(channels.confirmRendezvous(ctx(sender.user.id), sess.sessionId, m.rendezvousId, domain.generateToken(), true)).rejects.toMatchObject({ status: 403 });
    await channels.confirmRendezvous(ctx(sender.user.id), sess.sessionId, m.rendezvousId, sess.token, true);

    const got = await channels.pollRendezvous(listen.listenToken, ctx(null));
    expect(got).toMatchObject({ status: "confirmed", url: sess.url });
    expect((await channels.pollRendezvous(listen.listenToken, ctx(null))).url).toBeNull(); // handed over once
    const row = await one<{ token_enc: string | null }>("SELECT token_enc FROM exchange_rendezvous WHERE id=$1", [m.rendezvousId]);
    expect(row!.token_enc).toBeNull();
    const att = await one("SELECT 1 FROM exchange_attempts WHERE exchange_session_id=$1 AND channel='web_rendezvous' AND outcome='success'", [sess.sessionId]);
    expect(att).toBeTruthy();
    expect((await handoff.getSenderSessionStatus(ctx(sender.user.id), sess.sessionId)).state).toBe("OFFERED");
  });

  it("codes expire outside the time window; sender may reject; receiver may cancel", async () => {
    const sender = await signUp("rdv-sender2@test.io", "센더투");
    const sess = await handoff.createExchangeSession(ctx(sender.user.id), { capabilities: { receiverMode: "web_exchange_screen" }, group: false, context: {} });
    const old = await channels.startRendezvous(ctx(null));
    await q("UPDATE exchange_rendezvous SET expires_at = now() - interval '1 second' WHERE code=$1 AND status='waiting'", [old.code]);
    await expect(channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, old.code)).rejects.toMatchObject({ code: "rendezvous_not_found" });
    expect((await channels.pollRendezvous(old.listenToken, ctx(null))).status).toBe("expired");

    const l2 = await channels.startRendezvous(ctx(null));
    const m2 = await channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, l2.code);
    await channels.confirmRendezvous(ctx(sender.user.id), sess.sessionId, m2.rendezvousId, sess.token, false);
    expect((await channels.pollRendezvous(l2.listenToken, ctx(null))).status).toBe("rejected");

    const l3 = await channels.startRendezvous(ctx(null));
    await channels.cancelRendezvous(l3.listenToken);
    await expect(channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, l3.code)).rejects.toMatchObject({ code: "rendezvous_not_found" });

    // matched but unconfirmed past the confirm window → expired
    const l4 = await channels.startRendezvous(ctx(null));
    const m4 = await channels.matchRendezvous(ctx(sender.user.id), sess.sessionId, l4.code);
    await q("UPDATE exchange_rendezvous SET matched_at = now() - interval '5 minutes' WHERE id=$1", [m4.rendezvousId]);
    await expect(channels.confirmRendezvous(ctx(sender.user.id), sess.sessionId, m4.rendezvousId, sess.token, true)).rejects.toMatchObject({ code: "rendezvous_expired" });
  });
});

describe("F-039/F-040 BLE proximity with mutual confirmation", () => {
  it("issue → resolve → both confirm the same code → mutual relationship", async () => {
    const a = await signUp("prox-a@test.io", "에이", "native");
    const b = await signUp("prox-b@test.io", "비", "native");
    const sess = await handoff.createExchangeSession(ctx(a.user.id), { capabilities: { installedApp: true, nativeBle: true, receiverMode: "nearby_app" }, group: false, context: {} });
    expect(sess.channelPlan[0]).toBe("ble_proximity");

    const eph = await channels.issueProximityId(ctx(a.user.id), sess.sessionId);
    expect(domain.isEphemeralId(eph.ephemeralId)).toBe(true);
    expect(domain.serviceUuidToEphemeralId(eph.serviceUuid)).toBe(eph.ephemeralId);
    expect(await one("SELECT 1 FROM proximity_ids WHERE eph_hash=$1", [eph.ephemeralId])).toBeNull(); // hash only
    // only the session owner can issue
    await expect(channels.issueProximityId(ctx(b.user.id), sess.sessionId)).rejects.toMatchObject({ status: 404 });

    await expect(channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -90)).rejects.toMatchObject({ code: "too_far" });
    await expect(channels.resolveProximity(ctx(a.user.id), eph.ephemeralId, -40)).rejects.toMatchObject({ code: "self_exchange" });
    await expect(channels.resolveProximity(ctx(b.user.id), "0123456789abcdef", -40)).rejects.toMatchObject({ code: "proximity_not_found" });
    const r = await channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -45);
    expect(r.verifyCode).toMatch(/^\d{4}$/);
    expect(r.sender).toEqual({ name: "에이", company: "에이 Corp", jobTitle: null });
    // re-resolving while pending returns the same code
    expect((await channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -44)).verifyCode).toBe(r.verifyCode);

    const pending = await channels.listProximityMatches(ctx(a.user.id), sess.sessionId);
    expect(pending.matches).toHaveLength(1);
    expect(pending.matches[0]).toMatchObject({ verifyCode: r.verifyCode, receiverName: "비" });

    // nothing is exchanged after one confirmation
    expect(await channels.confirmProximity(ctx(b.user.id), r.matchId, true)).toMatchObject({ status: "pending", receiverConfirmed: true, senderConfirmed: false });
    expect(await one("SELECT 1 FROM contacts WHERE owner_user_id=$1", [a.user.id])).toBeNull();
    // a third party cannot confirm
    const c3 = await signUp("prox-c@test.io", "씨");
    await expect(channels.confirmProximity(ctx(c3.user.id), r.matchId, true)).rejects.toMatchObject({ status: 404 });

    const done = await channels.confirmProximity(ctx(a.user.id), r.matchId, true);
    expect(done.status).toBe("exchanged");
    const aContacts = await q<{ full_name: string; linked_user_id: string }>("SELECT full_name, linked_user_id FROM contacts WHERE owner_user_id=$1", [a.user.id]);
    const bContacts = await q<{ full_name: string; linked_user_id: string }>("SELECT full_name, linked_user_id FROM contacts WHERE owner_user_id=$1", [b.user.id]);
    expect(aContacts).toEqual([{ full_name: "비", linked_user_id: b.user.id }]);
    expect(bContacts).toEqual([{ full_name: "에이", linked_user_id: a.user.id }]);
    expect((await handoff.getSenderSessionStatus(ctx(a.user.id), sess.sessionId)).state).toBe("EXCHANGED");
    expect(await one("SELECT 1 FROM exchange_attempts WHERE exchange_session_id=$1 AND channel='ble_proximity' AND outcome='success'", [sess.sessionId])).toBeTruthy();
    expect((await channels.getProximityMatch(ctx(b.user.id), r.matchId)).status).toBe("exchanged");
    // idempotent re-confirm
    expect((await channels.confirmProximity(ctx(a.user.id), r.matchId, true)).status).toBe("exchanged");
    expect(await q("SELECT 1 FROM contacts WHERE owner_user_id=$1", [a.user.id])).toHaveLength(1);
  });

  it("a rejection or an expired window never exchanges", async () => {
    const a = await signUp("prox-a2@test.io", "에이투");
    const b = await signUp("prox-b2@test.io", "비투");
    const sess = await handoff.createExchangeSession(ctx(a.user.id), { capabilities: { installedApp: true, nativeBle: true, receiverHasApp: true }, group: false, context: {} });
    const eph = await channels.issueProximityId(ctx(a.user.id), sess.sessionId);
    const r = await channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -50);
    expect((await channels.confirmProximity(ctx(a.user.id), r.matchId, false)).status).toBe("rejected");
    expect((await channels.confirmProximity(ctx(b.user.id), r.matchId, true)).status).toBe("rejected");

    const r2 = await channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -50); // new pending match, new code
    await q("UPDATE proximity_matches SET expires_at = now() - interval '1 second' WHERE id=$1", [r2.matchId]);
    expect((await channels.confirmProximity(ctx(a.user.id), r2.matchId, true)).status).toBe("expired");
    expect(await one("SELECT 1 FROM contacts WHERE owner_user_id=$1", [a.user.id])).toBeNull();

    // expired ephemeral ids no longer resolve
    await q("UPDATE proximity_ids SET expires_at = now() - interval '1 second' WHERE exchange_session_id=$1", [sess.sessionId]);
    await expect(channels.resolveProximity(ctx(b.user.id), eph.ephemeralId, -50)).rejects.toMatchObject({ code: "proximity_not_found" });
  });
});

describe("F-052 offline receipts", () => {
  it("verifies device-signed pass + receipt and creates relationships idempotently", async () => {
    const a = await signUp("off-a@test.io", "오프에이", "native");
    const b = await signUp("off-b@test.io", "오프비", "native");
    const ka = await channels.registerDeviceKey(ctx(a.user.id), { platform: "ios" });
    const kb = await channels.registerDeviceKey(ctx(b.user.id), { platform: "android" });
    const stored = await one<{ secret_enc: string }>("SELECT secret_enc FROM device_exchange_keys WHERE key_id=$1", [ka.keyId]);
    expect(stored!.secret_enc).not.toContain(ka.secret);
    const profileA = (await card.primaryProfileId(a.user.id))!;

    const now = Date.now();
    const pass = domain.signOfflinePass({ v: 1, k: ka.keyId, u: a.user.id, p: profileA, n: "오프에이", iat: now - 60_000, exp: now + 3600_000, r: "n-1" }, ka.secret);
    const receiptId = randomUUID();
    const signed = domain.signOfflineReceipt({ v: 1, id: receiptId, k: kb.keyId, pass, at: now - 30_000, rc: true, pl: "지하 2층 부스" }, kb.secret);

    const first = await channels.syncOfflineReceipts(ctx(b.user.id), { receipts: [signed] });
    expect(first.results[0]).toMatchObject({ receiptId, status: "created", mutual: true });
    const again = await channels.syncOfflineReceipts(ctx(b.user.id), { receipts: [signed] });
    expect(again.results[0]).toMatchObject({ receiptId, status: "duplicate" });
    // the same pass under a new receipt id is also deduplicated
    const resend = domain.signOfflineReceipt({ v: 1, id: randomUUID(), k: kb.keyId, pass, at: now - 20_000, rc: true }, kb.secret);
    expect((await channels.syncOfflineReceipts(ctx(b.user.id), { receipts: [resend] })).results[0]!.status).toBe("duplicate");

    const bContacts = await q<{ full_name: string; linked_user_id: string }>("SELECT full_name, linked_user_id FROM contacts WHERE owner_user_id=$1", [b.user.id]);
    const aContacts = await q<{ full_name: string }>("SELECT full_name FROM contacts WHERE owner_user_id=$1", [a.user.id]);
    expect(bContacts).toEqual([{ full_name: "오프에이", linked_user_id: a.user.id }]);
    expect(aContacts).toEqual([{ full_name: "오프비" }]);
    const enc = await one<{ source: string; place_label: string; occurred_at: Date }>("SELECT source, place_label, occurred_at FROM encounters WHERE owner_user_id=$1", [b.user.id]);
    expect(enc).toMatchObject({ source: "offline_receipt", place_label: "지하 2층 부스" });
    expect(Math.abs(enc!.occurred_at.getTime() - (now - 30_000))).toBeLessThan(1000);
    expect(await one("SELECT 1 FROM outbox_events WHERE event_type='exchange.completed' AND aggregate_type='offline_receipt'")).toBeTruthy();
  });

  it("rejects forged, foreign, expired and self receipts", async () => {
    const a = await signUp("off-a2@test.io", "오프에이투");
    const b = await signUp("off-b2@test.io", "오프비투");
    const ka = await channels.registerDeviceKey(ctx(a.user.id), { platform: "ios" });
    const kb = await channels.registerDeviceKey(ctx(b.user.id), { platform: "android" });
    const profileA = (await card.primaryProfileId(a.user.id))!;
    const now = Date.now();
    const pass = (over: Partial<import("@linkos/domain").OfflinePassClaims> = {}, secret = ka.secret) =>
      domain.signOfflinePass({ v: 1, k: ka.keyId, u: a.user.id, p: profileA, n: "x", iat: now - 1000, exp: now + 3600_000, r: randomUUID(), ...over }, secret);
    const receipt = (p: string, over: Partial<import("@linkos/domain").OfflineReceiptClaims> = {}, secret = kb.secret) =>
      domain.signOfflineReceipt({ v: 1, id: randomUUID(), k: kb.keyId, pass: p, at: now - 500, rc: false, ...over }, secret);
    const sync = async (r: { payload: string; signature: string }, as = b.user.id) => (await channels.syncOfflineReceipts(ctx(as), { receipts: [r] })).results[0]!;

    expect(await sync(receipt(pass(), {}, ka.secret))).toMatchObject({ status: "rejected", reason: "bad_signature" });
    expect(await sync(receipt(pass()), a.user.id)).toMatchObject({ status: "rejected", reason: "unknown_device_key" });
    expect(await sync(receipt(pass({}, kb.secret)))).toMatchObject({ status: "rejected", reason: "bad_pass_signature" });
    expect(await sync(receipt(pass({ u: b.user.id })))).toMatchObject({ status: "rejected", reason: "unknown_sender_key" });
    expect(await sync(receipt(pass({ iat: now - 7200_000, exp: now - 3600_000 })))).toMatchObject({ status: "rejected", reason: "pass_expired" });
    expect(await sync(receipt(pass(), { at: now + 3600_000 }))).toMatchObject({ status: "rejected", reason: "receipt_in_future" });
    expect(await sync({ payload: "LKR1.garbage", signature: "x".repeat(43) })).toMatchObject({ status: "rejected", reason: "malformed" });
    const otherProfile = (await card.primaryProfileId(b.user.id))!;
    expect(await sync(receipt(pass({ p: otherProfile })))).toMatchObject({ status: "rejected", reason: "invalid_pass" });
    // revoked receiver key → signatures after revocation are refused
    await channels.revokeDeviceKey(ctx(b.user.id), kb.keyId);
    expect(await sync(receipt(pass()))).toMatchObject({ status: "rejected", reason: "device_key_revoked" });
    expect(await one("SELECT 1 FROM contacts WHERE owner_user_id=$1", [b.user.id])).toBeNull();
  });
});
