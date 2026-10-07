// X-001..X-007 integration (real PostgreSQL). Env: DATABASE_URL (default linkos_test_x).
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_x";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
for (const k of ["PASS_CERT", "PASS_KEY", "WWDR", "PASS_TYPE_ID", "PASS_TEAM_ID", "GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_EMAIL", "GOOGLE_WALLET_SA_KEY", "SMTP_URL"]) delete process.env[k];

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { assistantJobs, cardViews, card, handoff, identity, relationship, shareKit, closePool, q, one } = api;

const ctx = (userId: string | null, ip = "10.9.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
const stamp = Date.now();
let n = 0;
async function user(prefix = "x") {
  const email = `${prefix}${stamp}-${n++}@extras.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}

let owner: { id: string };
let profileId: string;
let slug: string;

beforeAll(async () => {
  await migrate();
  owner = await user("owner");
  const p = await card.saveProfile(ctx(owner.id), {
    ...base,
    name: "홍길동",
    company: "링코스랩",
    jobTitle: "대표",
    headline: "의료 AI",
    fields: [
      { type: "email", value: "hong@linkos.ai", visibility: "business" },
      { type: "mobile", value: "010-1234-5678", visibility: "trusted" },
      { type: "website", value: "linkos.ai", visibility: "public" },
      { type: "other", label: "메모", value: "secret-note", visibility: "private" },
    ],
    offers: ["의료 영상 AI 솔루션"],
    needs: ["병원 유통 파트너"],
  });
  profileId = p.id;
  slug = p.slug;
});
afterAll(async () => {
  // leave no unpublished outbox backlog for test files that share this database
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
  await closePool();
});

describe("X-001 email signature", () => {
  it("builds 3 styles from the exchange-audience card with a tracked /p link; trusted/private fields never appear", async () => {
    const r = await shareKit.emailSignatures(ctx(owner.id));
    expect(r.link).toBe(`https://linkos.test/p/${encodeURIComponent(slug)}?src=sig`);
    expect(r.signatures).toHaveLength(3);
    for (const s of r.signatures) {
      expect(s.html).toContain("hong@linkos.ai");
      expect(s.text).toContain(r.link);
      expect(s.html + s.text).not.toContain("010-1234-5678"); // trusted
      expect(s.html + s.text).not.toContain("secret-note"); // private
    }
  });
  it("requires login and a card", async () => {
    await expect(shareKit.emailSignatures(ctx(null))).rejects.toMatchObject({ status: 401 });
    const u = await user("nocard");
    await expect(shareKit.emailSignatures(ctx(u.id))).rejects.toMatchObject({ code: "profile_required" });
    await expect(shareKit.emailSignatures(ctx(u.id), profileId)).rejects.toMatchObject({ status: 404 }); // someone else's profile
  });
});

describe("X-002 virtual background data", () => {
  it("returns card text + tracked bg link only", async () => {
    const r = await shareKit.backgroundData(ctx(owner.id));
    expect(r.card).toEqual({ name: "홍길동", jobTitle: "대표", company: "링코스랩", headline: "의료 AI" });
    expect(r.link).toMatch(/\?src=bg$/);
  });
});

describe("X-003 card view analytics", () => {
  it("counts views/CTA/vCard/replies per session without any viewer identifier", async () => {
    const s = await handoff.createExchangeSession(ctx(owner.id), { capabilities: { webShare: true }, group: true, context: { placeLabel: "COEX" } });
    expect(await cardViews.recordView({ profileId, sessionId: s.sessionId, kind: "view" })).toBe(true);
    expect(await cardViews.recordView({ profileId, sessionId: s.sessionId, kind: "view" })).toBe(true);
    expect((await cardViews.recordClientSignal(ctx(null), { profileId, sessionId: s.sessionId, kind: "cta" }, {})).counted).toBe(true);
    expect((await cardViews.recordClientSignal(ctx(null), { profileId, sessionId: s.sessionId, kind: "vcard" }, {})).counted).toBe(true);
    await handoff.replyExchange(s.token, ctx(null), { card: { fullName: "김영희", email: "kim@medi.test" }, sharedFields: ["fullName", "email"], consent: { exchange: true }, provenance: {} });
    await cardViews.recordView({ profileId, kind: "link_sig" });
    const ins = await cardViews.cardViewInsights(owner.id, 30);
    expect(ins.totals).toMatchObject({ view: 2, cta: 1, vcard: 1, reply: 1, link_sig: 1 });
    expect(ins.series.view).toHaveLength(30);
    expect(ins.series.view.at(-1)).toBe(2);
    expect(ins.sessions[0]).toMatchObject({ sessionId: s.sessionId, placeLabel: "COEX", view: 2, reply: 1 });
    // the table has no column that could identify a viewer
    const cols = (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='card_view_daily'")).map((c) => c.column_name).sort();
    expect(cols).toEqual(["count", "day", "exchange_session_id", "kind", "profile_id"]);
  });

  it("GPC / DNT, the owner's own views and spoofed session ids are not counted", async () => {
    expect(await cardViews.recordView({ profileId, kind: "view", gpc: "1" })).toBe(false);
    expect(await cardViews.recordView({ profileId, kind: "view", dnt: "1" })).toBe(false);
    expect(await cardViews.recordView({ profileId, kind: "view", viewerUserId: owner.id })).toBe(false);
    const other = await user("other");
    const op = await card.saveProfile(ctx(other.id), { ...base, name: "타인" });
    const s = await handoff.createExchangeSession(ctx(other.id), { capabilities: {}, group: false, context: {} });
    expect((await cardViews.recordClientSignal(ctx(null), { profileId, sessionId: s.sessionId, kind: "cta" }, {})).counted).toBe(false);
    expect(cardViews.clientSignalInput.safeParse({ profileId, kind: "view" }).success).toBe(false); // views are server-side only
    expect(op.id).toBeTruthy();
  });

  it("opt-out stops counting and purges collected counts (audited)", async () => {
    const r = await cardViews.setPreference(ctx(owner.id), true);
    expect(r.purged).toBeGreaterThan(0);
    expect(await cardViews.recordView({ profileId, kind: "view" })).toBe(false);
    const ins = await cardViews.cardViewInsights(owner.id, 30);
    expect(ins.optOut).toBe(true);
    expect(ins.totals.view).toBe(0);
    expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='analytics.opted_out'", [owner.id])).toBeTruthy();
    await cardViews.setPreference(ctx(owner.id), false);
    expect(await cardViews.recordView({ profileId, kind: "view" })).toBe(true);
  });
});

describe("X-004 wallet pass", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "linkos-wallet-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("explains when not configured (501) and still builds a valid unsigned bundle", async () => {
    expect(shareKit.walletStatus().apple).toMatchObject({ configured: false, missing: ["PASS_CERT", "PASS_KEY", "WWDR", "PASS_TYPE_ID", "PASS_TEAM_ID"] });
    await expect(shareKit.applePass(ctx(owner.id))).rejects.toMatchObject({ status: 501, code: "wallet_not_configured" });
    const g = await shareKit.googleWallet(ctx(owner.id));
    expect(g.configured).toBe(false);
    expect(g.saveUrl).toBeNull();
    expect((g.object as any).header.defaultValue.value).toBe("홍길동");
  });

  it("signs a .pkpass when PASS_CERT/PASS_KEY/WWDR are set (signature verifies with openssl)", async () => {
    const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
    try {
      ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "wwdr.key", "-out", "wwdr.pem", "-days", "2", "-subj", "/CN=Test WWDR");
      ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "pass.key", "-out", "pass.csr", "-subj", "/CN=Pass Type ID: pass.ai.linkos.test");
      ossl("x509", "-req", "-in", "pass.csr", "-CA", "wwdr.pem", "-CAkey", "wwdr.key", "-CAcreateserial", "-out", "pass.pem", "-days", "2");
    } catch {
      return; // no openssl in this environment
    }
    process.env.PASS_CERT = Buffer.from(readFileSync(join(dir, "pass.pem"))).toString("base64");
    process.env.PASS_KEY = readFileSync(join(dir, "pass.key"), "utf8");
    process.env.WWDR = readFileSync(join(dir, "wwdr.pem"), "utf8");
    process.env.PASS_TYPE_ID = "pass.ai.linkos.test";
    process.env.PASS_TEAM_ID = "ABCDE12345";
    try {
      const r = await shareKit.applePass(ctx(owner.id));
      expect(r.filename).toBe("linkos-card.pkpass");
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(r.body);
      expect(Object.keys(zip.files).sort()).toEqual(["icon.png", "icon@2x.png", "logo.png", "logo@2x.png", "manifest.json", "pass.json", "signature"]);
      const pass = JSON.parse(await zip.file("pass.json")!.async("string"));
      expect(pass.passTypeIdentifier).toBe("pass.ai.linkos.test");
      expect(JSON.stringify(pass)).not.toContain("010-1234-5678");
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      const { createHash } = await import("node:crypto");
      expect(manifest["pass.json"]).toBe(createHash("sha1").update(await zip.file("pass.json")!.async("nodebuffer")).digest("hex"));
      writeFileSync(join(dir, "manifest.json"), await zip.file("manifest.json")!.async("nodebuffer"));
      writeFileSync(join(dir, "signature"), await zip.file("signature")!.async("nodebuffer"));
      expect(() => ossl("cms", "-verify", "-inform", "DER", "-binary", "-in", "signature", "-content", "manifest.json", "-CAfile", "wwdr.pem", "-purpose", "any", "-out", "/dev/null")).not.toThrow();
      expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='wallet.apple_pass_issued'", [owner.id])).toBeTruthy();
    } finally {
      for (const k of ["PASS_CERT", "PASS_KEY", "WWDR", "PASS_TYPE_ID", "PASS_TEAM_ID"]) delete process.env[k];
    }
  });

  it("issues a signed Save-to-Google-Wallet link when the service account is configured", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000012345678";
    process.env.GOOGLE_WALLET_SA_EMAIL = "wallet@linkos-test.iam.gserviceaccount.com";
    process.env.GOOGLE_WALLET_SA_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    try {
      const g = await shareKit.googleWallet(ctx(owner.id));
      expect(g.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
      const { jwtVerify } = await import("jose");
      const { payload } = await jwtVerify(g.saveUrl!.split("/save/")[1]!, publicKey, { audience: "google", issuer: "wallet@linkos-test.iam.gserviceaccount.com" });
      expect((payload as any).payload.genericObjects[0].id).toBe(`3388000000012345678.card_${profileId}`);
    } finally {
      for (const k of ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_EMAIL", "GOOGLE_WALLET_SA_KEY"]) delete process.env[k];
    }
  });
});

describe("X-007 event poster", () => {
  it("renders an A6/A4 PDF for a group session with its short code; refuses 1:1 sessions and other users", async () => {
    const g = await handoff.createExchangeSession(ctx(owner.id), { capabilities: { webShare: true, online: true }, group: true, context: { placeLabel: "AI EXPO 부스" } });
    expect(g.shortCode).toBeTruthy();
    for (const size of ["a6", "a4"] as const) {
      const pdf = await shareKit.eventPoster(ctx(owner.id), g.sessionId, size);
      expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.shortCode).toBe(g.shortCode);
      expect(pdf.body.includes(Buffer.from(g.token))).toBe(false); // the long token is never printed
    }
    const single = await handoff.createExchangeSession(ctx(owner.id), { capabilities: {}, group: false, context: {} });
    await expect(shareKit.eventPoster(ctx(owner.id), single.sessionId, "a6")).rejects.toMatchObject({ code: "group_required" });
    const other = await user("poster");
    await expect(shareKit.eventPoster(ctx(other.id), g.sessionId, "a6")).rejects.toMatchObject({ status: 404 });
    await handoff.revokeSession(ctx(owner.id), g.sessionId);
    await expect(shareKit.eventPoster(ctx(owner.id), g.sessionId, "a6")).rejects.toMatchObject({ code: "short_code_expired" });
  });
});

describe("X-005 meeting prep brief", () => {
  let contactId: string;
  let candId: string;
  it("notifies once, N minutes before an approved meeting with a known contact", async () => {
    const c = await relationship.createContact(ctx(owner.id), { fullName: "김영희", company: "메디파트너스", jobTitle: "이사", source: "manual", provenance: {}, encounter: { placeLabel: "COEX", occurredAt: new Date(Date.now() - 20 * 864e5).toISOString() } });
    contactId = c.contactId;
    await q("INSERT INTO notes (owner_user_id, contact_id, body) VALUES ($1,$2,'병원 3곳 소개 약속')", [owner.id, contactId]);
    const now = new Date();
    const cand = await one<{ id: string }>(
      `INSERT INTO calendar_candidates (owner_user_id, source, contact_id, title, starts_at, ends_at, status) VALUES ($1,'manual',$2,'분기 리뷰',$3,$4,'approved') RETURNING id`,
      [owner.id, contactId, new Date(now.getTime() + 20 * 60_000), new Date(now.getTime() + 80 * 60_000)],
    );
    candId = cand!.id;
    // too early for a 10-minute lead, due for the default 30
    await assistantJobs.setPrefs(ctx(owner.id), { prepBriefLeadMin: 10 });
    expect(await assistantJobs.processPrepBriefs(now)).toBe(0);
    await assistantJobs.setPrefs(ctx(owner.id), { prepBriefLeadMin: 30 });
    expect(await assistantJobs.processPrepBriefs(now)).toBe(1);
    expect(await assistantJobs.processPrepBriefs(now)).toBe(0); // once per entry
    const nrow = await one<{ title: string; body: string; link: string }>("SELECT title, body, link FROM notifications WHERE user_id=$1 AND kind='prep.brief'", [owner.id]);
    expect(nrow!.title).toContain("김영희");
    expect(nrow!.body).toContain("COEX");
    expect(nrow!.link).toBe(`/app/brief/${candId}`);
    expect(await one("SELECT 1 FROM push_notifications WHERE user_id=$1 AND dedupe_key=$2", [owner.id, `prep:${candId}`])).toBeTruthy();
  });

  it("the brief restates records only; inferred topics are labelled; other users get 404", async () => {
    const r = await assistantJobs.getPrepBrief(ctx(owner.id), candId);
    const kinds = r.brief!.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["who", "last_met", "note"]));
    expect(r.brief!.items.every((i) => (i.kind === "topic" ? i.provenance === "ai_inferred" : i.provenance === "record"))).toBe(true);
    const other = await user("brief");
    await expect(assistantJobs.getPrepBrief(ctx(other.id), candId)).rejects.toMatchObject({ status: 404 });
    const up = await assistantJobs.upcomingBriefs(ctx(owner.id));
    expect(up.upcoming.find((u) => u.candidateId === candId)?.contactName).toBe("김영희");
  });

  it("is off when lead=0 and skips meetings without a known contact", async () => {
    const u = await user("nolead");
    await assistantJobs.setPrefs(ctx(u.id), { prepBriefLeadMin: 0 });
    const c = await relationship.createContact(ctx(u.id), { fullName: "박", source: "manual", provenance: {} });
    const now = new Date();
    await q(`INSERT INTO calendar_candidates (owner_user_id, source, contact_id, title, starts_at, ends_at, status) VALUES ($1,'manual',$2,'a',$3,$4,'approved')`, [u.id, c.contactId, new Date(now.getTime() + 5 * 60_000), new Date(now.getTime() + 65 * 60_000)]);
    const v = await user("unknown");
    await q(`INSERT INTO calendar_candidates (owner_user_id, source, title, starts_at, ends_at, status, attendees) VALUES ($1,'manual','b',$2,$3,'approved','[{"email":"nobody@x.test"}]')`, [v.id, new Date(now.getTime() + 5 * 60_000), new Date(now.getTime() + 65 * 60_000)]);
    await assistantJobs.processPrepBriefs(now);
    expect(await one("SELECT 1 FROM notifications WHERE user_id = ANY($1::uuid[]) AND kind='prep.brief'", [[u.id, v.id]])).toBeNull();
  });
});

describe("X-006 re-connect digest", () => {
  it("weekly digest of cooling relationships; one-tap draft is saved, never sent", async () => {
    const u = await user("digest");
    await card.saveProfile(ctx(u.id), { ...base, name: "나보내" });
    const ids: string[] = [];
    for (const [i, name] of ["가", "나", "다", "라"].entries()) {
      const c = await relationship.createContact(ctx(u.id), { fullName: `${name}님`, company: "회사", source: "manual", provenance: {}, tags: ["vip"], encounter: { placeLabel: "행사", occurredAt: new Date(Date.now() - (100 + i * 10) * 864e5).toISOString() } });
      ids.push(c.contactId);
    }
    await q("UPDATE relationships SET last_contact_at = NULL WHERE owner_user_id=$1", [u.id]);
    const today = new Date();
    const d = await assistantJobs.currentDigest(ctx(u.id), today);
    expect(d.items).toHaveLength(3);
    expect(d.items.every((i) => i.provenance === "ai_inferred")).toBe(true);
    // the worker does not create a second digest for the same week
    expect(await assistantJobs.generateDigest(u.id, today)).toBeNull();
    const msg = await assistantJobs.createReconnectDraft(ctx(u.id), d.items[0]!.contactId);
    expect(msg.status).toBe("draft");
    expect(msg.provenance).toBe("rules");
    expect(msg.body).toContain("행사");
    expect(msg.body).toContain("나보내 드림");
    expect(await one("SELECT 1 FROM messages WHERE id=$1 AND sent_at IS NULL", [msg.id])).toBeTruthy();
    const again = await assistantJobs.currentDigest(ctx(u.id), today);
    expect(again.items.find((i) => i.contactId === d.items[0]!.contactId)?.draftMessageId).toBe(msg.id);
    // next week: previously suggested people are skipped while others remain
    const next = await assistantJobs.generateDigest(u.id, new Date(today.getTime() + 7 * 864e5), { notifyUser: false });
    expect(next!.items.map((i) => i.contactId)).not.toContain(d.items[0]!.contactId);
    // other users cannot draft for my contacts
    const other = await user("digest2");
    await expect(assistantJobs.createReconnectDraft(ctx(other.id), ids[0]!)).rejects.toMatchObject({ status: 404 });
  });

  it("worker announces the digest in the inbox; users who turned it off get nothing", async () => {
    const u = await user("digest3");
    await relationship.createContact(ctx(u.id), { fullName: "마님", source: "manual", provenance: {}, tags: ["vip"], encounter: { occurredAt: new Date(Date.now() - 200 * 864e5).toISOString() } });
    await q("UPDATE relationships SET last_contact_at = NULL WHERE owner_user_id=$1", [u.id]);
    const off = await user("digest4");
    await relationship.createContact(ctx(off.id), { fullName: "바님", source: "manual", provenance: {}, tags: ["vip"], encounter: { occurredAt: new Date(Date.now() - 200 * 864e5).toISOString() } });
    await assistantJobs.setPrefs(ctx(off.id), { reconnectDigest: false });
    for (let i = 0; i < 20 && (await assistantJobs.processReconnectDigests(new Date(), 100)) > 0; i++);
    expect(await one("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='reconnect.digest' AND link='/app/reconnect'", [u.id])).toBeTruthy();
    expect(await one("SELECT 1 FROM reconnect_digests WHERE user_id=$1", [off.id])).toBeNull();
  });
});

describe("audit G-01 match.created", () => {
  it("is emitted once per pair through the outbox and notifies the subject owner", async () => {
    const a = await user("ma");
    const b = await user("mb");
    await card.saveProfile(ctx(a.id), { ...base, name: "에이", needs: ["병원 유통 파트너 찾기"] });
    const pb = await card.saveProfile(ctx(b.id), { ...base, name: "비", offers: ["병원 유통 파트너 네트워크"] });
    await relationship.createContact(ctx(a.id), { fullName: "비", email: `x${stamp}@m.test`, source: "manual", provenance: {} });
    await q("UPDATE contacts SET linked_user_id=$2 WHERE owner_user_id=$1", [a.id, b.id]);
    const m1 = await api.ai.listMatches(ctx(a.id));
    expect(m1.results[0]?.candidateId).toBe(pb.id);
    await api.ai.listMatches(ctx(a.id));
    const evs = await q<{ payload: any }>("SELECT payload FROM outbox_events WHERE event_type='match.created' AND payload->>'candidate_id'=$1", [pb.id]);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ candidate_id: pb.id, reasons: expect.arrayContaining(["need_offer"]) });
    expect(JSON.stringify(evs[0]!.payload)).not.toContain("병원");
    await relayOutbox(500);
    expect(await one("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='match.created'", [a.id])).toBeTruthy();
  });
});
