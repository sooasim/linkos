// Whitepaper gap closure — acceptance paths against Postgres:
// §20 audit hash chain (tamper detection, concurrency, authorized purge) · F-163/F-165 vault key versioning + rotation ·
// F-064 referral attribution for Google/Apple sign-ups · F-139 CRM-sync-required policy · F-188 §23 KPIs ·
// §20 RUM web vitals · event catalog consumers (guest.claimed, meeting.actions.extracted, privacy.deletion.requested).
import { createCipheriv, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encounterMaintenance } from "./encounterMaintenance";
import { type FakeApple, startFakeApple } from "./fakeApple";
import { type FakeGoogle, startFakeGoogle } from "./fakeGoogle";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_wp";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
const K1 = Buffer.alloc(32, 21).toString("base64");
const K2 = Buffer.alloc(32, 22).toString("base64");
process.env.CREDENTIALS_KEY = K1;
delete process.env.CREDENTIALS_KEYS;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const vault = await import("../src/lib/vault");
const { rotateSealedColumns, SEALED_COLUMNS } = await import("../src/lib/vaultRotate");
const { sealObject, openObject } = await import("../src/lib/storage");
const { analytics, apple, auditChain, audit, card, enterprise, handoff, identity, integration, meeting, org, policy, referral, relationship, security, pool, q, one, tx, closePool } = api;

const ctx = (userId: string | null, ip = "10.9.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const stamp = Date.now();
let n = 0;
async function user(prefix = "u") {
  const email = `${prefix}${stamp}-${n++}@wp.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}
const baseProfile = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
async function drain() {
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
}

let fakeGoogle: FakeGoogle;
let fakeApple: FakeApple;
beforeAll(async () => {
  fakeGoogle = await startFakeGoogle();
  process.env.GOOGLE_API_BASE = fakeGoogle.url;
  fakeApple = await startFakeApple();
  process.env.APPLE_API_BASE = fakeApple.url;
  process.env.APPLE_CLIENT_ID = fakeApple.clientId;
  process.env.APPLE_TEAM_ID = fakeApple.teamId;
  process.env.APPLE_KEY_ID = fakeApple.keyId;
  process.env.APPLE_PRIVATE_KEY = fakeApple.privateKeyPem.replace(/\n/g, "\\n");
  await migrate();
});
afterAll(async () => {
  await drain();
  await fakeGoogle.close();
  await fakeApple.close();
  await closePool();
});

describe("§20 audit log durability — hash chain", () => {
  beforeAll(async () => {
    // this file owns a fresh chain (other test files TRUNCATE audit_logs in a shared CI database)
    await q("TRUNCATE audit_logs, audit_log_tombstones");
  });

  it("chains concurrent writers (pool + caller transactions) without gaps and verifies", async () => {
    const u = await user("audit");
    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => audit(pool(), ctx(u.id), "test.concurrent", "user", u.id, { i, email: "x@y.io" })),
      ...Array.from({ length: 5 }, (_, i) => tx(async (c) => audit(c, ctx(u.id), "test.in_tx", "user", u.id, { i }))),
    ]);
    const r = await auditChain.verifyAuditChain();
    expect(r).toMatchObject({ ok: true, unsealed: 0 });
    expect(r.checked).toBeGreaterThanOrEqual(31);
    const seqs = (await q<{ s: string }>("SELECT chain_seq::text AS s FROM audit_logs ORDER BY chain_seq")).map((x) => Number(x.s));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // contiguous
    // metadata is still redacted before it is hashed/stored
    expect(JSON.stringify(await q("SELECT metadata FROM audit_logs WHERE action='test.concurrent'"))).not.toContain("x@y.io");
  });

  it("a writer that finds the chain lock busy never waits; the sealer links its row later", async () => {
    const c = await pool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [api.AUDIT_CHAIN_LOCK]);
      await audit(pool(), ctx(null), "test.lock_busy", null, null);
      expect(await one("SELECT 1 FROM audit_logs WHERE action='test.lock_busy' AND chain_seq IS NULL")).toBeTruthy();
      expect(await auditChain.sealAuditChain()).toBe(0); // busy → skip this tick
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(await auditChain.sealAuditChain()).toBe(1);
    expect(await auditChain.verifyAuditChain({ seal: false })).toMatchObject({ ok: true, unsealed: 0 });
  });

  it("authorized purges (retention) leave tombstones; the chain still verifies", async () => {
    const o = await user("purge");
    await audit(pool(), ctx(o.id), "test.purge_me", "user", o.id);
    await audit(pool(), ctx(o.id), "test.keep", "user", o.id);
    const purged = await tx((c) => auditChain.purgeAuditLogs(c, "action = $1", ["test.purge_me"], "retention"));
    expect(purged).toBe(1);
    expect(await one("SELECT 1 FROM audit_log_tombstones WHERE reason='retention'")).toBeTruthy();
    expect(await auditChain.verifyAuditChain()).toMatchObject({ ok: true, tombstones: 1 });
  });

  it("an external anchor proves the chain was not truncated", async () => {
    const head = (await auditChain.verifyAuditChain()).head;
    expect(await auditChain.verifyAuditChain({ anchor: head })).toMatchObject({ ok: true, anchor: "ok" });
    expect(await auditChain.verifyAuditChain({ anchor: { ...head, hash: "0".repeat(64) } })).toMatchObject({ ok: false, anchor: "mismatch" });
  });

  it("detects an edited row and a silently deleted row", async () => {
    const target = await one<{ id: string; chain_seq: string }>("SELECT id::text, chain_seq::text FROM audit_logs WHERE action='test.in_tx' ORDER BY chain_seq LIMIT 1");
    await q("UPDATE audit_logs SET metadata = '{\"i\": 99}' WHERE id=$1", [target!.id]);
    const edited = await auditChain.verifyAuditChain();
    expect(edited.ok).toBe(false);
    expect(edited.break).toMatchObject({ chainSeq: Number(target!.chain_seq), reason: "hash_mismatch" });

    await q("TRUNCATE audit_logs, audit_log_tombstones");
    for (let i = 0; i < 4; i++) await audit(pool(), ctx(null), "test.del", null, null, { i });
    expect((await auditChain.verifyAuditChain()).ok).toBe(true);
    await q("DELETE FROM audit_logs WHERE chain_seq = 2");
    expect((await auditChain.verifyAuditChain()).break).toMatchObject({ chainSeq: 2, reason: "missing_row" });
    await q("TRUNCATE audit_logs, audit_log_tombstones"); // leave a clean chain for the rest of the file
  });
});

describe("F-163/F-165 vault key versioning + rotation", () => {
  const restore = () => {
    process.env.CREDENTIALS_KEY = K1;
    delete process.env.CREDENTIALS_KEYS;
  };
  afterAll(restore);

  it("parses CREDENTIALS_KEYS (first = active) and stays compatible with CREDENTIALS_KEY", () => {
    expect(vault.parseKeyring({ CREDENTIALS_KEY: K1 }).map((k) => k.id)).toEqual(["v1"]);
    expect(vault.parseKeyring({ CREDENTIALS_KEYS: `v2:${K2},v1:${K1}` }).map((k) => k.id)).toEqual(["v2", "v1"]);
    expect(vault.parseKeyring({ CREDENTIALS_KEYS: `v2:${K2}`, CREDENTIALS_KEY: K1 }).map((k) => k.id)).toEqual(["v2", "v1"]);
    expect(vault.parseKeyring({ CREDENTIALS_KEYS: `v2:${K2},v1:${K1}`, CREDENTIALS_KEY: K1 }).map((k) => k.id)).toEqual(["v2", "v1"]);
    expect(() => vault.parseKeyring({ CREDENTIALS_KEYS: "v2:short" })).toThrow(/32 bytes/);
    expect(() => vault.parseKeyring({ CREDENTIALS_KEYS: `v2:${K2},v2:${K1}` })).toThrow(/duplicate/);
    expect(() => vault.parseKeyring({ NODE_ENV: "production" })).toThrow();
  });

  it("ciphertext carries the key version; legacy blobs still open; rotation re-seals every sealed column", async () => {
    restore();
    const u = await user("vault");
    const legacy = (() => {
      // pre-versioning format: iv | tag | ciphertext under the single CREDENTIALS_KEY
      const iv = randomBytes(12);
      const ci = createCipheriv("aes-256-gcm", Buffer.from(K1, "base64"), iv);
      const enc = Buffer.concat([ci.update(JSON.stringify({ refresh_token: "legacy-rt" })), ci.final()]);
      return Buffer.concat([iv, ci.getAuthTag(), enc]);
    })();
    expect(vault.sealedKeyId(legacy)).toBeNull();
    const a1 = await one<{ id: string }>("INSERT INTO integration_accounts (user_id, provider, scopes, encrypted_credentials, status) VALUES ($1,'google','{}',$2,'active') RETURNING id", [u.id, legacy]);
    const v1 = vault.seal({ secret: "wh-secret" });
    expect(vault.sealedKeyId(v1)).toBe("v1");
    const wh = await one<{ id: string }>("INSERT INTO webhook_endpoints (owner_user_id, url, events, secret_sealed) VALUES ($1,'https://hooks.example.com/x','{contact.updated}',$2) RETURNING id", [u.id, v1]);
    const obj = sealObject("objects/wp-test", Buffer.from("hello"));

    // deploy a new active key; old ciphertexts keep working
    process.env.CREDENTIALS_KEYS = `v2:${K2},v1:${K1}`;
    delete process.env.CREDENTIALS_KEY;
    expect(vault.activeKeyId()).toBe("v2");
    expect(vault.sealedKeyId(vault.seal({ a: 1 }))).toBe("v2");
    expect(vault.unseal<{ refresh_token: string }>(legacy).refresh_token).toBe("legacy-rt");
    expect(vault.unseal<{ secret: string }>(v1).secret).toBe("wh-secret");
    expect(openObject("objects/wp-test", obj).toString()).toBe("hello");

    const cols = SEALED_COLUMNS.filter((c) => ["integration_accounts", "webhook_endpoints"].includes(c.table));
    const dry = await rotateSealedColumns({ dryRun: true, columns: cols });
    expect(dry.stats.reduce((s, x) => s + x.resealed, 0)).toBeGreaterThanOrEqual(2);
    const run = await rotateSealedColumns({ columns: cols });
    expect(run.stats.every((s) => s.failed === 0)).toBe(true);
    const again = await rotateSealedColumns({ columns: cols });
    expect(again.stats.reduce((s, x) => s + x.resealed, 0)).toBe(0); // idempotent
    const ia = await one<{ encrypted_credentials: Buffer }>("SELECT encrypted_credentials FROM integration_accounts WHERE id=$1", [a1!.id]);
    const we = await one<{ secret_sealed: Buffer }>("SELECT secret_sealed FROM webhook_endpoints WHERE id=$1", [wh!.id]);
    expect(vault.sealedKeyId(ia!.encrypted_credentials)).toBe("v2");
    expect(vault.sealedKeyId(we!.secret_sealed)).toBe("v2");

    // retire the old key: rotated rows still open
    process.env.CREDENTIALS_KEYS = `v2:${K2}`;
    expect(vault.unseal<{ refresh_token: string }>(ia!.encrypted_credentials).refresh_token).toBe("legacy-rt");
    expect(vault.unseal<{ secret: string }>(we!.secret_sealed).secret).toBe("wh-secret");
    expect(() => vault.unseal(v1)).toThrow(/key "v1" is not configured/);
    // storage data keys re-wrap too (object bytes untouched)
    process.env.CREDENTIALS_KEYS = `v2:${K2},v1:${K1}`;
    const rewrapped = vault.reseal(obj.wrappedKey, Buffer.from("linkos-dek-v1"));
    process.env.CREDENTIALS_KEYS = `v2:${K2}`;
    expect(openObject("objects/wp-test", { ...obj, wrappedKey: rewrapped }).toString()).toBe("hello");
    await q("DELETE FROM integration_accounts WHERE id=$1", [a1!.id]);
    await q("DELETE FROM webhook_endpoints WHERE id=$1", [wh!.id]);
    restore();
  });
});

describe("F-064 referral attribution for Google and Apple sign-ups", () => {
  async function referrerCode() {
    const r = await user("referrer");
    return { id: r.id, code: (await referral.myReferrals(ctx(r.id))).code };
  }

  it("Google OAuth sign-up with the /r/{code} cookie is attributed once (source=link)", async () => {
    const ref = await referrerCode();
    const { user: gu } = await integration.exchangeGoogleCode("code-wp");
    const g = { ...gu, sub: `g-wp-${stamp}`, email: `google${stamp}@wp.test` };
    const r = await identity.signInWithGoogleOAuth(ctx(null), g, consents, ref.code);
    expect(r.isNew).toBe(true);
    expect(await one("SELECT 1 FROM referral_attributions WHERE referrer_user_id=$1 AND referred_user_id=$2 AND source='link'", [ref.id, r.user.id])).toBeTruthy();
    expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='auth.signup'", [r.user.id])).toBeTruthy();
    // returning user: no new attribution, no error
    const again = await identity.signInWithGoogleOAuth(ctx(null), g, consents, ref.code);
    expect(again.isNew).toBe(false);
    expect((await q("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1", [r.user.id])).length).toBe(1);
    // bad / unknown codes are ignored silently
    const other = await identity.signInWithGoogleOAuth(ctx(null), { ...g, sub: `g-wp2-${stamp}`, email: `google2${stamp}@wp.test` }, consents, "NOTACODE");
    expect(other.isNew).toBe(true);
    expect(await one("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1", [other.user.id])).toBeNull();
  });

  it("Apple sign-up carries the code through the one-time state (form_post has no Lax cookies)", async () => {
    const ref = await referrerCode();
    const { url } = await apple.appleAuthStart(ctx(null), { next: "/app", consentAccepted: true, referralCode: ref.code });
    const form = await fakeApple.authorize(url, { sub: `apple-wp-${stamp}`, email: `apple${stamp}@wp.test` });
    const r = await apple.appleCallback(ctx(null), form);
    expect(r.isNew).toBe(true);
    expect(await one("SELECT 1 FROM referral_attributions WHERE referrer_user_id=$1 AND referred_user_id=$2 AND source='link'", [ref.id, r.userId])).toBeTruthy();
    // the code is never stored for malformed input
    await apple.appleAuthStart(ctx(null), { referralCode: "x' OR 1=1" });
    expect(await one("SELECT 1 FROM apple_login_states WHERE referral_code LIKE '%OR%'")).toBeNull();
  });
});

describe("F-139 CRM sync required (org policy)", () => {
  it("company leads are queued for the owner's CRM; a missing CRM is recorded and gated", async () => {
    const owner = await user("crmowner");
    const o = await org.createOrg(ctx(owner.id), { name: `CRM Policy ${stamp}` });
    const orgId = (o as { id: string }).id;
    await enterprise.updatePolicies(ctx(owner.id), orgId, enterprise.policiesInput.parse({ requireCrmSync: true, crmSyncProviders: ["hubspot"] }));
    await expect(policy.assertCrmSyncPolicy(orgId, owner.id)).rejects.toMatchObject({ status: 422, code: "policy_violation" });

    const k = await enterprise.createApiKey(ctx(owner.id), orgId, { name: "lead intake", scopes: ["leads:write"] });
    const auth = await enterprise.authenticateApiKey(`Bearer ${k.key}`, "leads:write");
    const lead1 = await enterprise.apiCreateLead(auth, relationship.contactInput.parse({ fullName: "정책리드", company: "에이씨" }));
    const a1 = await one<{ metadata: any }>("SELECT metadata FROM audit_logs WHERE action='apikey.lead_created' AND entity_id=$1", [lead1.id]);
    expect(a1!.metadata.crm_sync).toBe("crm_not_connected");
    expect(await one("SELECT 1 FROM sync_jobs WHERE payload->>'contactId'=$1", [lead1.id])).toBeNull();

    // owner connects HubSpot → the policy is satisfiable and new company leads are pushed
    await q("INSERT INTO integration_accounts (user_id, provider, scopes, encrypted_credentials, status) VALUES ($1,'hubspot','{}',$2,'active')", [owner.id, api.integration.seal({ access_token: "t" })]);
    await policy.assertCrmSyncPolicy(orgId, owner.id);
    const lead2 = await enterprise.apiCreateLead(auth, relationship.contactInput.parse({ fullName: "정책리드2" }));
    const job = await one<{ job_type: string; payload: any; provider: string }>("SELECT job_type, payload, provider FROM sync_jobs WHERE payload->>'contactId'=$1", [lead2.id]);
    expect(job).toMatchObject({ provider: "hubspot", payload: { policy: "require_crm_sync" } });
    expect(job!.job_type).toMatch(/^crm\.(lead|contact)\.upsert$/);
    // idempotent; personal contacts are never forced into the CRM
    expect((await tx((c) => policy.enqueueRequiredCrmSync(c, lead2.id))).queued).toBe(false);
    const personal = await relationship.createContact(ctx(owner.id), { fullName: "개인연락처", source: "manual", provenance: {} });
    expect(await tx((c) => policy.enqueueRequiredCrmSync(c, personal.contactId))).toMatchObject({ required: false, queued: false });
    // contact.updated consumer enforces it for the earlier lead now that a CRM is connected
    await q("INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('contact',$1,'contact.updated',$2)", [lead1.id, JSON.stringify({ contact_id: lead1.id, changed_fields: ["company"] })]);
    await drain();
    expect(await one("SELECT 1 FROM sync_jobs WHERE payload->>'contactId'=$1 AND payload->>'policy'='require_crm_sync'", [lead1.id])).toBeTruthy();
  });
});

describe("F-188 §23 KPIs + §20 RUM", () => {
  it("retention, match-to-meeting and enterprise active relationships from existing tables", async () => {
    const me = await user("kpi");
    const peer = await user("kpipeer");
    const old = await relationship.createContact(ctx(me.id), { fullName: "지난달", source: "manual", provenance: {} });
    await q("UPDATE contacts SET created_at = now() - interval '45 days' WHERE id=$1", [old.contactId]);
    await encounterMaintenance("UPDATE encounters SET occurred_at = now() - interval '45 days' WHERE contact_id=$1", [old.contactId]);
    let r = await analytics.retentionKpi(me.id, 30);
    expect(r).toMatchObject({ previousActive: 1 });
    // the signup-month activity of `me` is all old except what we add now
    await q("UPDATE exchange_sessions SET created_at = now() - interval '45 days' WHERE sender_user_id=$1", [me.id]);
    await relationship.addNote(ctx(me.id), old.contactId, "다시 연락");
    r = await analytics.retentionKpi(me.id, 30);
    expect(r).toMatchObject({ previousActive: 1, retained: 1, retentionRate: 100 });

    const p1 = await card.saveProfile(ctx(me.id), { ...baseProfile, name: "나" });
    const p2 = await card.saveProfile(ctx(peer.id), { ...baseProfile, name: "피어" });
    await q("INSERT INTO match_announcements (subject_profile_id, candidate_profile_id, score) VALUES ($1,$2,0.8)", [p1.id, p2.id]);
    expect(await analytics.matchToMeetingKpi(me.id, 30)).toMatchObject({ matches: 1, matchesWithMeeting: 0, matchToMeetingRate: 0 });
    const pc = await relationship.createContact(ctx(me.id), { fullName: "피어", source: "manual", provenance: {} });
    await q("UPDATE contacts SET linked_user_id=$2 WHERE id=$1", [pc.contactId, peer.id]);
    await meeting.saveMeeting(ctx(me.id), { title: "매칭 후 미팅", participantContactIds: [pc.contactId], discussion: [], decisions: [], promises: [], actionItems: [] } as never);
    expect(await analytics.matchToMeetingKpi(me.id, 30)).toMatchObject({ matches: 1, matchesWithMeeting: 1, matchToMeetingRate: 100 });

    const o = (await org.createOrg(ctx(me.id), { name: `KPI Org ${stamp}` })) as { id: string };
    const shared = await relationship.createContact(ctx(me.id), { fullName: "팀고객", source: "manual", provenance: {} });
    const idle = await relationship.createContact(ctx(me.id), { fullName: "휴면고객", source: "manual", provenance: {} });
    await q("UPDATE contacts SET organization_id=$2, scope='org', ownership='company' WHERE id = ANY($1::uuid[])", [[shared.contactId, idle.contactId], o.id]);
    await q("UPDATE contacts SET updated_at = now() - interval '90 days' WHERE id=$1", [idle.contactId]);
    await encounterMaintenance("UPDATE encounters SET occurred_at = now() - interval '90 days' WHERE contact_id=$1", [idle.contactId]);
    expect(await analytics.enterpriseActiveRelationships([o.id], 30)).toMatchObject({ organizations: 1, orgRelationships: 2, activeRelationships: 1, activeRate: 50 });

    const k = await analytics.exchangeKpis(me.id, 30);
    expect(k).toMatchObject({ retentionRate: 100, matchToMeetingRate: 100, enterpriseActiveRelationships: { orgRelationships: 2 } });
    expect(k).toHaveProperty("guestLandingLcpP75Ms");
  });

  it("RUM samples are PII-free route patterns; p75 of guest landing LCP is reported", async () => {
    await q("DELETE FROM web_vitals_samples");
    const tok = "AbCdEfGhIjKlMnOpQrStUvWx";
    const res = await analytics.recordVitals([1000, 2000, 3000, 4000].map((v) => ({ name: "LCP", value: v, rating: v > 2500 ? "needs-improvement" : "good", navigationType: "navigate", path: `/x/${tok}?ref=kim@example.com` })));
    expect(res.stored).toBe(4);
    expect((await analytics.recordVitals([{ name: "LCP", value: "x", rating: "good", path: "/" }, { evil: true }])).stored).toBe(0);
    await analytics.recordVitals({ name: "CLS", value: 0.01, rating: "good", path: "/app/people/2b1f0b5e-8a4c-4a5b-9e0d-1c2d3e4f5a6b" });
    const all = JSON.stringify(await q("SELECT * FROM web_vitals_samples"));
    expect(all).not.toContain(tok);
    expect(all).not.toContain("kim@example.com");
    expect(all).not.toContain("2b1f0b5e");
    const v = await analytics.webVitalsKpi(30);
    expect(v.guestLandingLcpP75Ms).toBe(3250);
    expect(v.guestLandingLcpWithinTarget).toBe(false);
    expect(v.metrics.find((m) => m.route === "/x/[token]" && m.metric === "LCP")).toMatchObject({ samples: 4, goodRate: 50 });
  });
});

describe("event catalog consumers (worker dispatch)", () => {
  it("guest.claimed → emitted on claim, consumed: strengths refreshed + sender notified (no duplicate attribution)", async () => {
    const sender = await user("claimsender");
    await card.saveProfile(ctx(sender.id), { ...baseProfile, name: "보낸이" });
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: false, context: {} } as never);
    await handoff.openGuestLanding(s.token, ctx(null, "10.9.9.9"), "anon-wp");
    const rep = await handoff.replyExchange(s.token, ctx(null, "10.9.9.9"), { card: { fullName: "게스트" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} });
    const guest = await user("claimguest");
    await handoff.claimGuest(ctx(guest.id), rep.claimToken!);
    const ev = await one<{ id: string; payload: any }>("SELECT id, payload FROM outbox_events WHERE event_type='guest.claimed' AND payload->>'user_id'=$1", [guest.id]);
    expect(ev).toBeTruthy();
    await drain();
    expect(await one("SELECT 1 FROM outbox_events WHERE id=$1 AND published_at IS NOT NULL", [ev!.id])).toBeTruthy();
    expect(await one("SELECT 1 FROM relationships WHERE owner_user_id=$1 AND strength_computed_at IS NOT NULL", [guest.id])).toBeTruthy();
    expect(await one("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='guest.claimed'", [sender.id])).toBeTruthy();
    expect((await q("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1", [guest.id])).length).toBeLessThanOrEqual(1);
    // replay is idempotent (one notification)
    await q("UPDATE outbox_events SET published_at=NULL WHERE id=$1", [ev!.id]);
    await drain();
    expect((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='guest.claimed'", [sender.id])).length).toBe(1);
  });

  it("meeting.actions.extracted → draft follow-ups per action item, idempotent, never sent", async () => {
    const u = await user("actions");
    const c = await relationship.createContact(ctx(u.id), { fullName: "회의상대", source: "manual", provenance: {} });
    const m = await meeting.saveMeeting(ctx(u.id), { title: "액션 회의", participantContactIds: [c.contactId], discussion: [], decisions: [], promises: [], actionItems: [{ description: "제안서 송부", contactId: c.contactId, status: "open" }, { description: "완료된 일", status: "done" }] } as never);
    expect(await one("SELECT 1 FROM outbox_events WHERE event_type='meeting.actions.extracted' AND payload->>'meeting_id'=$1", [m.id])).toBeTruthy();
    await drain();
    const f = await q<{ title: string; status: string; source: string; contact_id: string }>("SELECT title, status, source, contact_id FROM followups WHERE owner_user_id=$1 AND action_item_id IS NOT NULL", [u.id]);
    expect(f).toEqual([{ title: "제안서 송부", status: "open", source: "meeting", contact_id: c.contactId }]);
    // re-saving the card re-emits the event: no duplicate drafts; nothing was sent
    await meeting.saveMeeting(ctx(u.id), { title: "액션 회의", participantContactIds: [c.contactId], discussion: [], decisions: [], promises: [], actionItems: m.actionItems.map((a: any) => ({ id: a.id, description: a.description, contactId: a.contactId ?? null, status: a.status })) } as never, m.id);
    await drain();
    expect((await q("SELECT 1 FROM followups WHERE owner_user_id=$1 AND action_item_id IS NOT NULL", [u.id])).length).toBe(1);
    expect(await q("SELECT 1 FROM messages WHERE owner_user_id=$1", [u.id])).toHaveLength(0);
  });

  it("privacy.deletion.requested → consumed idempotently: the deletion pipeline is (re)asserted", async () => {
    const u = await user("deleter");
    await q("INSERT INTO integration_accounts (user_id, provider, scopes, status) VALUES ($1,'google','{}','active')", [u.id]);
    const acct = await one<{ id: string }>("SELECT id FROM integration_accounts WHERE user_id=$1", [u.id]);
    await q("INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key) VALUES ($1,'google.contact.upsert','{}','wp-del-1')", [acct!.id]);
    await security.requestDeletion(ctx(u.id));
    const ev = await one<{ id: string }>("SELECT id FROM outbox_events WHERE event_type='privacy.deletion.requested' AND payload->>'subject_id'=$1", [u.id]);
    expect(ev).toBeTruthy();
    // simulate a lost pipeline row (partial failure / restore) — the consumer re-creates it
    await q("DELETE FROM deletion_requests WHERE user_id=$1", [u.id]);
    await drain();
    expect(await one("SELECT 1 FROM outbox_events WHERE id=$1 AND published_at IS NOT NULL", [ev!.id])).toBeTruthy();
    expect((await q("SELECT 1 FROM deletion_requests WHERE user_id=$1 AND status='scheduled'", [u.id])).length).toBe(1);
    expect(await one<{ status: string }>("SELECT status FROM sync_jobs WHERE idempotency_key='wp-del-1'")).toEqual({ status: "skipped" });
    // replay: still exactly one scheduled request
    await q("UPDATE outbox_events SET published_at=NULL WHERE id=$1", [ev!.id]);
    await drain();
    expect((await q("SELECT 1 FROM deletion_requests WHERE user_id=$1", [u.id])).length).toBe(1);
    expect(await one<{ status: string }>("SELECT status FROM users WHERE id=$1", [u.id])).toEqual({ status: "pending_deletion" });
  });
});
