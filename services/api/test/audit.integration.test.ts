// Audit 2026-10 — acceptance-path tests for features that were implemented without tests, and for the gaps fixed
// in this audit (docs/AUDIT_2026-10.md): F-005 F-011 F-023 F-027 F-028 F-029 F-030 F-069 F-070 F-078 F-143 F-162
// F-165 F-170, G-02 (OCR evidence minimization), G-03 (guest SSE status), G-05 (sealed idempotent responses).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_x";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { processReminders, relayOutbox } = await import("../src/worker");
const { capture, card, handoff, identity, meeting, relationship, withIdempotency, closePool, q, one } = api;

const ctx = (userId: string | null, ip = "10.7.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
const stamp = Date.now();
let n = 0;
async function user(prefix = "a") {
  const email = `${prefix}${stamp}-${n++}@audit.test`;
  const { devCode } = await identity.requestOtp(ctx(null, `10.7.${n}.1`), email);
  return (await identity.verifyOtp(ctx(null, `10.7.${n}.1`), email, devCode!, consents)).user;
}
const REPO = resolve(__dirname, "../../..");

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  // leave no unpublished outbox backlog for test files that share this database
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
  await closePool();
});

describe("F-005 다중 프로필", () => {
  it("a user keeps separate profiles and can exchange with a non-primary one; others' profiles are refused", async () => {
    const u = await user("multi");
    const personal = await card.saveProfile(ctx(u.id), { ...base, name: "김개인" });
    const work = await card.saveProfile(ctx(u.id), { ...base, name: "김대표", company: "회사A", jobTitle: "CEO" });
    expect((await card.listMyProfiles(u.id)).map((p) => p.name).sort()).toEqual(["김개인", "김대표"]);
    const s = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, profileId: work.id, context: {} });
    const landing = await handoff.openGuestLanding(s.token, ctx(null, "10.7.200.1"), "anon-multi");
    expect(landing.sender.name).toBe("김대표");
    expect(landing.sender.company).toBe("회사A");
    expect(personal.id).not.toBe(work.id);
    const other = await user("multi2");
    await card.saveProfile(ctx(other.id), { ...base, name: "타인" });
    await expect(handoff.createExchangeSession(ctx(other.id), { capabilities: {}, group: false, profileId: work.id, context: {} })).rejects.toMatchObject({ status: 404 });
  });
});

describe("F-011 앞·뒤면 병합", () => {
  it("front + back OCR lines are parsed together (one card, back-side fields kept)", async () => {
    const u = await user("scan");
    const job = await capture.captureBusinessCard(ctx(u.id), {
      side: "both",
      kind: "card",
      engine: "tesseract.js",
      lines: [{ text: "홍길동", confidence: 95 }, { text: "링코스랩 대표이사", confidence: 90 }],
      backLines: [{ text: "Gildong Hong", confidence: 90 }, { text: "hong@linkos.ai", confidence: 96 }, { text: "+82 10-1234-5678", confidence: 93 }],
    });
    const keys = job.fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["fullName", "email", "mobile"]));
    expect(job.fields.find((f) => f.key === "email")!.value).toBe("hong@linkos.ai");
    const row = await one<{ raw_ocr: any }>("SELECT raw_ocr FROM business_cards WHERE id=$1", [job.id]);
    expect(row!.raw_ocr.lines).toHaveLength(5);
    expect(await one("SELECT 1 FROM cost_ledger WHERE job_id=$1 AND units=2", [job.id])).toBeTruthy(); // two pages metered
  });
});

describe("F-023 / F-027~F-030 30초 카드 · 딥 프로필 (Interest/Asset/Network/Project)", () => {
  it("deep sections persist and are shown to business+ audiences only", async () => {
    const u = await user("deep");
    const p = await card.saveProfile(ctx(u.id), {
      ...base,
      name: "딥프로필",
      bioShort: "30초 소개 문장",
      deep: { interests: ["의료AI"], assets: ["임상 데이터셋"], network: ["대학병원 20곳"], projects: [{ title: "PACS 연동", status: "진행중" }] },
    });
    const full = (await card.loadProfile(p.id))!;
    expect(full.deep).toMatchObject({ interests: ["의료AI"], assets: ["임상 데이터셋"], network: ["대학병원 20곳"], projects: [{ title: "PACS 연동", status: "진행중" }] });
    expect(card.projectCard(full, "public").deep).toBeNull();
    expect(card.projectCard(full, "public").bioShort).toBe("30초 소개 문장");
    expect(card.projectCard(full, "business").deep).toMatchObject({ interests: ["의료AI"] });
    // validation: oversized deep lists are rejected
    expect(card.profileInput.safeParse({ ...base, name: "x", deep: { interests: Array.from({ length: 13 }, (_, i) => `i${i}`) } }).success).toBe(false);
  });
});

describe("F-069 회사 엔터티 · F-070 태그", () => {
  it("contacts at the same company share one company entity; tags filter and stay per owner", async () => {
    const u = await user("co");
    const a = await relationship.createContact(ctx(u.id), { fullName: "가", company: "(주)링코스랩", source: "manual", provenance: {}, tags: ["VIP", "의료"] });
    const b = await relationship.createContact(ctx(u.id), { fullName: "나", company: "링코스랩 주식회사", source: "manual", provenance: {}, tags: ["의료"] });
    const ids = await q<{ company_id: string }>("SELECT company_id FROM contacts WHERE id = ANY($1::uuid[])", [[a.contactId, b.contactId]]);
    expect(new Set(ids.map((r) => r.company_id)).size).toBe(1);
    expect((await relationship.listContacts(u.id, { tag: "의료" })).map((c) => c.fullName).sort()).toEqual(["가", "나"]);
    expect((await relationship.listContacts(u.id, { tag: "VIP" })).map((c) => c.fullName)).toEqual(["가"]);
    const other = await user("co2");
    expect(await relationship.listContacts(other.id, { tag: "의료" })).toEqual([]);
  });
});

describe("F-078 연락 필요일", () => {
  it("a due date on a follow-up sets the relationship's next contact date and fires one reminder when due", async () => {
    const u = await user("due");
    const c = await relationship.createContact(ctx(u.id), { fullName: "다음연락", source: "manual", provenance: {} });
    const due = new Date(Date.now() - 60_000).toISOString();
    const f = await meeting.createFollowup(ctx(u.id), { contactId: c.contactId, kind: "check_in", title: "안부 연락", dueAt: due } as any);
    const rel = await one<{ next_followup_at: Date }>("SELECT next_followup_at FROM relationships WHERE owner_user_id=$1 AND contact_id=$2", [u.id, c.contactId]);
    expect(rel!.next_followup_at.toISOString()).toBe(due);
    await processReminders(500);
    await processReminders(500);
    const evs = await q("SELECT 1 FROM outbox_events WHERE event_type='followup.due' AND payload->>'followup_id'=$1", [(f as any).id]);
    expect(evs).toHaveLength(1);
    const other = await user("due2");
    await expect(meeting.createFollowup(ctx(other.id), { contactId: c.contactId, kind: "custom", title: "x" } as any)).rejects.toBeTruthy();
  });
});

describe("F-143 현장 교환 · F-162/G-02 데이터 최소화", () => {
  it("the place label lands on the encounter; unshared OCR lines never reach the sender", async () => {
    const s = await user("site");
    await card.saveProfile(ctx(s.id), { ...base, name: "현장" });
    const x = await handoff.createExchangeSession(ctx(s.id), { capabilities: {}, group: false, context: { placeLabel: "코엑스 B홀" } });
    await handoff.replyExchange(x.token, ctx(null, "10.7.201.1"), {
      card: { fullName: "게스트", company: "메디", email: "guest@medi.test", phone: "010-7777-6666" },
      sharedFields: ["fullName", "company", "email"],
      consent: { exchange: true },
      provenance: {},
      ocr: { lines: [{ text: "게스트 팀장", confidence: 90 }, { text: "메디", confidence: 90 }, { text: "M 010-7777-6666", confidence: 90 }, { text: "guest@medi.test", confidence: 90 }, { text: "서울 강남구 비공개로 9", confidence: 80 }] },
    });
    const enc = await one<{ place_label: string }>("SELECT e.place_label FROM encounters e JOIN contacts c ON c.id=e.contact_id WHERE e.owner_user_id=$1 AND c.full_name='게스트'", [s.id]);
    expect(enc!.place_label).toBe("코엑스 B홀");
    const bc = await one<{ raw_ocr: any }>("SELECT raw_ocr FROM business_cards WHERE captured_by=$1 AND source='guest_exchange'", [s.id]);
    expect(bc!.raw_ocr.minimized).toBe(true);
    const everything = JSON.stringify(await q("SELECT raw_ocr, structured_data FROM business_cards WHERE captured_by=$1", [s.id])) + JSON.stringify(await q("SELECT * FROM contacts WHERE owner_user_id=$1", [s.id]));
    expect(everything).not.toMatch(/7777-6666|77776666/);
    expect(everything).not.toContain("비공개로");
    expect(everything).toContain("guest@medi.test");
  });
});

describe("F-170 Rate Limit", () => {
  it("OTP requests are limited per email and per IP with Retry-After", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    try {
      const email = `rl${stamp}@audit.test`;
      for (let i = 0; i < 5; i++) await identity.requestOtp(ctx(null, "10.7.250.1"), email);
      const err = await identity.requestOtp(ctx(null, "10.7.250.1"), email).catch((e) => e);
      expect(err).toMatchObject({ status: 429, code: "rate_limited" });
      expect(err.details.retryAfter).toBeGreaterThan(0);
      // guest landing opens are limited per IP too (short codes more strictly)
      const owner = await user("rl");
      await card.saveProfile(ctx(owner.id), { ...base, name: "RL" });
      const sx = await handoff.createExchangeSession(ctx(owner.id), { capabilities: { online: true }, group: true, context: {} });
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) limited = await handoff.openGuestLanding(sx.shortCode!, ctx(null, "10.7.251.1"), `a${i}`).then(() => false, (e) => e.status === 429);
      expect(limited).toBe(true);
    } finally {
      process.env.RATE_LIMIT_DISABLED = "1";
    }
  });
});

describe("F-165 비밀관리", () => {
  it("every env var the code reads is documented in .env.example and secrets are blank there", () => {
    const example = readFileSync(join(REPO, ".env.example"), "utf8");
    const documented = new Map<string, string>();
    for (const line of example.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) documented.set(m[1]!, m[2]!);
    }
    const src = execFileSync("git", ["grep", "-hoE", "process\\.env\\.[A-Z0-9_]+", "--", "services/api/src", "apps/web/src"], { cwd: REPO }).toString();
    const used = new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!));
    for (const k of ["PASS_CERT", "PASS_KEY", "WWDR", "PASS_TYPE_ID", "PASS_TEAM_ID", "GOOGLE_WALLET_ISSUER_ID"]) used.add(k); // read via env[k]
    const missing = [...used].filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
    for (const [k, v] of documented) if (/SECRET|PRIVATE_KEY|_KEY$|PASSWORD|PASSPHRASE|_TOKEN$|^PASS_CERT$|^WWDR$/.test(k) && k !== "AUTH_SECRET") expect(`${k}=${v}`).toBe(`${k}=`);
  });
  it("no private keys or live credentials are committed", () => {
    const r = spawnSync("git", ["grep", "-lE", "BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY|sk_live_[0-9A-Za-z]{10}|AKIA[0-9A-Z]{16}|xox[bp]-[0-9A-Za-z-]{10}", "--", ".", ":!*.test.ts", ":!docs/AUDIT_2026-10.md"], { cwd: REPO });
    expect(r.stdout.toString()).toBe("");
    expect(r.status).toBe(1); // git grep: 1 = no match
  });
});

describe("G-03 guest-safe session status (SSE source)", () => {
  it("exposes only state/acceptsReply/expiresAt and follows revocation", async () => {
    const s = await user("sse");
    await card.saveProfile(ctx(s.id), { ...base, name: "SSE", fields: [{ type: "email", value: "sse@x.test", visibility: "business" }] });
    const x = await handoff.createExchangeSession(ctx(s.id), { capabilities: {}, group: false, context: {} });
    const st = await handoff.getGuestSessionStatus(x.token, ctx(null));
    expect(Object.keys(st).sort()).toEqual(["acceptsReply", "expiresAt", "state"]);
    expect(st.acceptsReply).toBe(true);
    await handoff.revokeSession(ctx(s.id), x.sessionId);
    expect(await handoff.getGuestSessionStatus(x.token, ctx(null))).toMatchObject({ state: "REVOKED", acceptsReply: false });
    await expect(handoff.getGuestSessionStatus("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", ctx(null))).rejects.toMatchObject({ status: 404 });
  });
});

describe("G-13 integration.sync.failed has a notification consumer", () => {
  it("the account owner is told once (deduped) with a link to the integrations page", async () => {
    const u = await user("syncfail");
    const acct = await one<{ id: string }>("INSERT INTO integration_accounts (user_id, provider, status) VALUES ($1,'hubspot','active') RETURNING id", [u.id]);
    const job = await one<{ id: string }>("INSERT INTO sync_jobs (integration_account_id, job_type, payload, status, provider) VALUES ($1,'crm.contact.upsert','{}','dead','hubspot') RETURNING id", [acct!.id]);
    await api.tx(async (c) => {
      await api.emit(c, "integration.sync.failed", "sync_job", job!.id, { provider: "hubspot", job_id: job!.id, error_class: "conflict" });
      await api.emit(c, "integration.sync.failed", "sync_job", job!.id, { provider: "hubspot", job_id: job!.id, error_class: "conflict" });
    });
    for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
    const rows = await q<{ title: string; link: string }>("SELECT title, link FROM notifications WHERE user_id=$1 AND kind='integration.sync.failed'", [u.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "hubspot 동기화 충돌", link: "/app/integrations" });
  });
});

describe("G-05 idempotent responses are sealed at rest", () => {
  it("a replay returns the same body, but the stored row never contains the exchange token in plain text", async () => {
    const u = await user("idem");
    await card.saveProfile(ctx(u.id), { ...base, name: "IDEM" });
    const key = `k-${stamp}-idem`;
    const run = () => withIdempotency(`xch:${u.id}`, key, { group: false }, async () => ({ status: 201, body: await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: {} }) }));
    const first = await run();
    const second = await run();
    expect(second.replayed).toBe(true);
    expect(second.body.token).toBe(first.body.token);
    const row = await one<{ response: any }>("SELECT response FROM idempotency_keys WHERE scope=$1 AND key=$2", [`xch:${u.id}`, key]);
    expect(JSON.stringify(row!.response)).not.toContain(first.body.token);
    expect(typeof row!.response.sealed).toBe("string");
    await expect(withIdempotency(`xch:${u.id}`, key, { group: true }, async () => ({ status: 201, body: {} }))).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });
});
