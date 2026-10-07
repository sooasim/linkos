// Track B — communication, scheduling, CRM and outbound integrations, against local fakes of every external API.
// F-104 F-105 F-106 F-107 F-108 F-110 F-111 F-112 F-115 F-116 F-118 F-119 F-120 F-121 F-122 F-123 F-126 F-127 F-128 F-087 F-088 F-146 F-157
import { createECDH, createHmac, randomBytes } from "node:crypto";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCrm, startFakeCrm } from "./fakeCrm";
import { type FakeGoogle, startFakeGoogle } from "./fakeGoogle";
import { type FakeAnthropic, type FakePush, type FakeReceiver, type FakeSmtp, startFakeAnthropic, startFakePush, startFakeSmtp, startReceiver } from "./fakeMisc";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.GOOGLE_CLIENT_ID = "g-client";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";
for (const p of ["MICROSOFT", "SALESFORCE", "HUBSPOT", "DYNAMICS"]) {
  process.env[`${p}_CLIENT_ID`] = `${p.toLowerCase()}-client`;
  process.env[`${p}_CLIENT_SECRET`] = `${p.toLowerCase()}-secret`;
}
process.env.WEBHOOK_ALLOW_PRIVATE = "1";
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.LLM_DISABLED;

let g: FakeGoogle;
let crmFake: FakeCrm;
let smtp: FakeSmtp;
let pushSvc: FakePush;
let hook: FakeReceiver;
let llm: FakeAnthropic;

const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = "mailto:test@linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox, processReminders } = await import("../src/worker");
const { identity, integration, relationship, meeting, card, connection, event, comms, calendar, crm, push, webhooks, q, one, closePool } = api;
const ctx = (userId: string | null) => ({ userId, ip: `10.9.${Math.floor(Math.random() * 200)}.1`, userAgent: "test", requestId: "t" });

async function user(prefix: string) {
  const email = `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}@test.io`;
  const smtpUrl = process.env.SMTP_URL;
  delete process.env.SMTP_URL; // OTP codes are echoed in dev mode only when mail is not configured
  const { devCode } = await identity.requestOtp(ctx(null), email).finally(() => (process.env.SMTP_URL = smtpUrl));
  return (await identity.verifyOtp(ctx(null), email, devCode!, ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true })))).user;
}
async function contact(uid: string, fullName: string, extra: Record<string, unknown> = {}) {
  return (await relationship.createContact(ctx(uid), { fullName, source: "manual", provenance: {}, ...extra })).contactId;
}
async function connectGoogle(uid: string) {
  const { tok } = await integration.exchangeGoogleCode("code");
  await integration.storeGoogleAccount(uid, tok);
}
async function connectCrm(uid: string, p: "microsoft" | "salesforce" | "hubspot" | "dynamics", extra: { orgUrl?: string } = {}) {
  const { url } = crm.crmAuthUrl(p, uid, extra);
  const state = new URL(url).searchParams.get("state")!;
  await crm.completeCrmOAuth(p, ctx(uid), "auth-code", state);
}
const profileBase = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };

beforeAll(async () => {
  [g, crmFake, smtp, pushSvc, hook, llm] = await Promise.all([startFakeGoogle(), startFakeCrm(), startFakeSmtp(), startFakePush(), startReceiver(), startFakeAnthropic()]);
  process.env.GOOGLE_API_BASE = g.url;
  for (const p of ["MICROSOFT", "SALESFORCE", "HUBSPOT", "DYNAMICS"]) process.env[`${p}_API_BASE`] = crmFake.url;
  process.env.SMTP_URL = smtp.url;
  process.env.ANTHROPIC_BASE_URL = llm.url;
  https.globalAgent.options.ca = [pushSvc.ca];
  await migrate();
});
afterAll(async () => {
  await Promise.all([g.close(), crmFake.close(), smtp.close(), pushSvc.close(), hook.close(), llm.close()]);
  await closePool();
});

describe("F-111 템플릿", () => {
  it("validates variables, renders from the user's own records and reports missing values", async () => {
    const uid = (await user("tpl")).id;
    await card.saveProfile(ctx(uid), { ...profileBase, name: "이지은", company: "링코스" });
    const cid = await contact(uid, "김민수", { company: "에이사" });
    await expect(comms.saveTemplate(ctx(uid), comms.templateInput.parse({ name: "x", body: "{{salary}}" }))).rejects.toMatchObject({ code: "unknown_variables" });
    const t = await comms.saveTemplate(ctx(uid), comms.templateInput.parse({ name: "감사", subject: "{{company}} {{name}}님께", body: "{{firstName}}님, {{place}}에서 반가웠습니다.\n{{myName}} ({{myCompany}})" }));
    expect(t.editable).toBe(true);
    const r = await comms.renderTemplateFor(ctx(uid), t.id, { contactId: cid });
    expect(r.subject).toBe("에이사 김민수님께");
    expect(r.body).toBe("민수님, 에서 반가웠습니다.\n이지은 (링코스)");
    expect(r.missing).toEqual(["place"]);
    // team templates require membership
    const org = await one<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ('팀', $1) RETURNING id", [`org-${Date.now()}`]);
    await expect(comms.saveTemplate(ctx(uid), comms.templateInput.parse({ name: "팀", body: "hi", scope: "org", organizationId: org!.id }))).rejects.toMatchObject({ status: 403 });
    await q("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'member')", [org!.id, uid]);
    const teamT = await comms.saveTemplate(ctx(uid), comms.templateInput.parse({ name: "팀", body: "{{name}}님 안녕하세요", scope: "org", organizationId: org!.id }));
    const other = (await user("tpl2")).id;
    await q("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'member')", [org!.id, other]);
    const list = await comms.listTemplates(other);
    expect(list.templates.find((x) => x.id === teamT.id)).toMatchObject({ scope: "org", editable: false });
    expect(list.templates.find((x) => x.id === t.id)).toBeUndefined(); // personal template stays private
  });
});

describe("F-104 → F-106 이메일 발송 (approval) · F-115 Gmail 초안", () => {
  let uid: string;
  let cid: string;
  it("AI draft becomes a message draft; nothing is sent without explicit approval", async () => {
    uid = (await user("mail")).id;
    cid = await contact(uid, "박하늘", { email: "sky@client.io" });
    const d = await comms.createAiDraft(ctx(uid), cid, "thank_you");
    expect(d).toMatchObject({ status: "draft", toAddress: "sky@client.io", provenance: "rules", needsConfirmation: true });
    expect(comms.sendInput.safeParse({ approved: false }).success).toBe(false);
    expect(comms.sendInput.safeParse({}).success).toBe(false);
    expect(smtp.messages.length).toBe(0);
  });

  it("SMTP fallback when no mail account is connected; idempotent on repeat", async () => {
    const [d] = await comms.listMessages(uid, { contactId: cid });
    const sent = await comms.sendMessage(ctx(uid), d!.id, { approved: true, via: "auto" });
    expect(sent).toMatchObject({ status: "sent", provider: "smtp" });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual(["sky@client.io"]);
    expect(smtp.messages[0]!.data).toMatch(/Reply-To: .*@test\.io/);
    const again = await comms.sendMessage(ctx(uid), d!.id, { approved: true, via: "auto" });
    expect(again.status).toBe("sent");
    expect(smtp.messages).toHaveLength(1); // second approval never sends twice
    await expect(comms.updateMessage(ctx(uid), d!.id, { body: "edit" })).rejects.toMatchObject({ code: "not_editable" });
    const auditRow = await one<{ metadata: any }>("SELECT metadata FROM audit_logs WHERE actor_user_id=$1 AND action='message.sent'", [uid]);
    expect(auditRow!.metadata).toMatchObject({ provider: "smtp", approved: true });
    expect(JSON.stringify(auditRow!.metadata)).not.toContain("sky@client.io");
    expect((await one<{ last_contact_at: Date }>("SELECT last_contact_at FROM relationships WHERE contact_id=$1", [cid]))!.last_contact_at).toBeTruthy();
  });

  it("Gmail draft (F-115) then Gmail send (gmail.send) with RFC 2047 subject", async () => {
    await connectGoogle(uid);
    const m = await comms.createMessage(ctx(uid), comms.messageInput.parse({ contactId: cid, subject: "자료 보내드립니다", body: "안녕하세요,\n첨부 확인 부탁드립니다." }));
    const draft = await comms.saveGmailDraft(ctx(uid), m.id);
    expect(draft.gmailDraftId).toMatch(/^r-/);
    expect(g.gmailDrafts.get(draft.gmailDraftId!)!.raw).toContain("To: =?UTF-8?B?");
    await comms.updateMessage(ctx(uid), m.id, { body: "수정된 본문" });
    const again = await comms.saveGmailDraft(ctx(uid), m.id);
    expect(again.gmailDraftId).toBe(draft.gmailDraftId); // PUT, not a second draft
    expect(g.gmailDrafts.size).toBe(1);
    const sent = await comms.sendMessage(ctx(uid), m.id, { approved: true, via: "auto" });
    expect(sent).toMatchObject({ status: "sent", provider: "gmail" });
    const raw = g.gmailSent.at(-1)!.raw;
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("<sky@client.io>");
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe("수정된 본문");
    expect(g.gmailDrafts.size).toBe(0); // the Gmail draft was cleaned up after sending
  });

  it("send failure is recorded and retryable; invalid recipients are rejected", async () => {
    const m = await comms.createMessage(ctx(uid), comms.messageInput.parse({ contactId: cid, subject: "s", body: "b" }));
    g.failNext(500);
    await expect(comms.sendMessage(ctx(uid), m.id, { approved: true, via: "gmail" })).rejects.toBeTruthy();
    expect((await comms.getMessage(uid, m.id)).status).toBe("failed");
    expect((await comms.sendMessage(ctx(uid), m.id, { approved: true, via: "gmail" })).status).toBe("sent");
    await expect(comms.createMessage(ctx(uid), comms.messageInput.parse({ toAddress: "a@b.io\r\nBcc: x@y.io", subject: "s", body: "b" }))).rejects.toMatchObject({ code: "invalid_recipient" });
  });
});

describe("F-112 언어 번역", () => {
  it("translates a draft via the LLM (AI label) and falls back to the original with a notice", async () => {
    const uid = (await user("tr")).id;
    const cid = await contact(uid, "John Kim", { email: "john@x.io" });
    const m = await comms.createMessage(ctx(uid), comms.messageInput.parse({ contactId: cid, subject: "감사합니다", body: "만나서 반가웠습니다." }));
    const t = await comms.translate(ctx(uid), comms.translateInput.parse({ target: "en", messageId: m.id, saveAsDraft: true }));
    expect(t).toMatchObject({ translated: true, provenance: "ai_inferred", needsConfirmation: true, items: { subject: "[EN] 감사합니다", body: "[EN] 만나서 반가웠습니다." } });
    expect(t.draft).toMatchObject({ language: "en", status: "draft", subject: "[EN] 감사합니다" });
    expect(llm.requests.at(-1).messages[0].content).toContain("<data>");
    const f = await comms.translate(ctx(uid), comms.translateInput.parse({ target: "en", text: "번역불가 문장" }));
    expect(f).toMatchObject({ translated: false, provenance: "none", items: { text: "번역불가 문장" } });
    expect(f.notice).toContain("원문");
  });
});

describe("F-105 후속 메시지 시퀀스", () => {
  it("creates dated reminders + drafts (short SMS), sends nothing, cancel dismisses all", async () => {
    const uid = (await user("seq")).id;
    const cid = await contact(uid, "최바다", { email: "sea@x.io", phone: "010-1234-5678" });
    const before = smtp.messages.length + g.gmailSent.length;
    const s = await comms.createSequence(ctx(uid), comms.sequenceInput.parse({ contactId: cid }));
    expect(s.steps).toHaveLength(3);
    expect(s.steps[1]!.channel).toBe("sms");
    expect(s.steps[1]!.message.body.length).toBeLessThanOrEqual(90);
    expect(s.steps[1]!.message.smsLink).toMatch(/^sms:010-1234-5678\?body=/);
    expect(new Date(s.steps[2]!.dueAt!).getTime()).toBeGreaterThan(new Date(s.steps[1]!.dueAt!).getTime());
    expect(smtp.messages.length + g.gmailSent.length).toBe(before);
    const f = await q("SELECT id FROM followups WHERE sequence_id=$1 AND status='open'", [s.id]);
    expect(f).toHaveLength(3);
    await comms.cancelSequence(ctx(uid), s.id);
    expect(await q("SELECT id FROM followups WHERE sequence_id=$1 AND status='open'", [s.id])).toHaveLength(0);
    expect((await comms.listMessages(uid, { contactId: cid })).every((m) => m.status === "cancelled")).toBe(true);
  });
});

describe("F-087 일정 후보 → F-108 승인 → F-118 Google Calendar (+ ICS)", () => {
  let uid: string;
  let mid: string;
  let candId: string;
  it("turns a next-meeting hint into proposed slots (rules provenance) — no date, no candidate", async () => {
    uid = (await user("cal")).id;
    await connectGoogle(uid);
    const cid = await contact(uid, "정하람", { email: "haram@x.io" });
    mid = (await meeting.saveMeeting(ctx(uid), meeting.meetingInput.parse({ title: "파일럿 논의", participantContactIds: [cid] }))).id;
    const none = await calendar.proposeFromMeeting(ctx(uid), mid, calendar.fromMeetingInput.parse({ hint: "곧 다시 뵙죠" }));
    expect(none.candidates).toHaveLength(0);
    const r = await calendar.proposeFromMeeting(ctx(uid), mid, calendar.fromMeetingInput.parse({ hint: "다음 주 화요일 오후 3시" }));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ status: "proposed", provenance: "rules", sourceText: "다음 주 화요일 오후 3시", attendees: [{ email: "haram@x.io", name: "정하람" }] });
    expect(r.busySource).toBe("google");
    candId = r.candidates[0]!.id;
  });

  it("approval creates the Google event idempotently (client event id) and records the mapping", async () => {
    const eventId = candId.replace(/-/g, "");
    const out = await calendar.decideCandidate(ctx(uid), candId, calendar.decideInput.parse({ approve: true }));
    expect(out.calendarSync).toMatchObject({ provider: "google", status: "done" });
    const ev = g.events.get(eventId)!;
    expect(ev.body.attendees).toEqual([{ email: "haram@x.io", displayName: "정하람" }]);
    expect(ev.sendUpdates).toBe("none"); // attendees are not emailed unless the user asks
    expect(out.calendarEvent ?? (await calendar.listCandidates(uid, { meetingId: mid }))[0]!.calendarEvent).toBeTruthy();
    const m = await one<{ next_meeting_at: Date }>("SELECT next_meeting_at FROM meetings WHERE id=$1", [mid]);
    expect(new Date(m!.next_meeting_at).toISOString()).toBe(new Date(out.startsAt).toISOString());
    // ICS fallback
    const ics = await calendar.candidateIcs(uid, candId);
    expect(ics.body).toContain(`UID:${candId}@linkos`);
    expect(ics.body).toContain("STATUS:CONFIRMED");
  });

  it("reschedule PATCHes with If-Match; a remote edit becomes a conflict, resolved only by the user", async () => {
    const eventId = candId.replace(/-/g, "");
    const start = new Date(Date.now() + 9 * 86400000);
    start.setUTCMinutes(0, 0, 0);
    let out = await calendar.decideCandidate(ctx(uid), candId, calendar.decideInput.parse({ approve: true, startsAt: start.toISOString() }));
    expect(out.version).toBe(2);
    expect(g.calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(g.events.get(eventId)!.body.start.dateTime).toBe(start.toISOString());
    g.touchEvent(eventId); // someone edits the event in Google Calendar
    out = await calendar.decideCandidate(ctx(uid), candId, calendar.decideInput.parse({ approve: true, startsAt: new Date(start.getTime() + 3600000).toISOString() }));
    expect(out.calendarSync.status).toBe("conflict");
    const j = await crm.syncJournal(uid, crm.journalQuery.parse({ status: "conflict" }));
    expect(j.entries[0]).toMatchObject({ provider: "google", jobType: "calendar.event.upsert", canResolve: true });
    const res = await crm.resolveConflict(ctx(uid), j.entries[0]!.id, "overwrite");
    expect(res).toMatchObject({ status: "done", resolution: "overwrite_approved" });
    expect(g.events.get(eventId)!.body.start.dateTime).toBe(new Date(start.getTime() + 3600000).toISOString());
  });

  it("a lost create response cannot duplicate the event; users without a calendar get ICS only", async () => {
    const r = await calendar.createCandidates(ctx(uid), calendar.manualCandidatesInput.parse({ title: "점심", slots: [{ startsAt: new Date(Date.now() + 5 * 86400000).toISOString(), endsAt: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString() }] }));
    const id = r[0]!.id;
    g.events.set(id.replace(/-/g, ""), { etag: '"pre"', body: {}, sendUpdates: null }); // created by an earlier attempt whose response was lost
    const before = g.events.size;
    const out = await calendar.decideCandidate(ctx(uid), id, calendar.decideInput.parse({ approve: true }));
    expect(out.calendarSync.status).toBe("done");
    expect(g.events.size).toBe(before);
    const noCal = (await user("nocal")).id;
    const c2 = await calendar.createCandidates(ctx(noCal), calendar.manualCandidatesInput.parse({ title: "커피", slots: [{ startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString() }] }));
    expect((await calendar.decideCandidate(ctx(noCal), c2[0]!.id, calendar.decideInput.parse({ approve: true }))).calendarSync).toMatchObject({ status: "ics_only" });
    await expect(calendar.decideCandidate(ctx(uid), c2[0]!.id, calendar.decideInput.parse({ approve: true }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("F-107 캘린더 예약 링크", () => {
  it("public page shows free slots (availability − Google busy); guest request → owner approval → event", async () => {
    const uid = (await user("book")).id;
    await connectGoogle(uid);
    await card.saveProfile(ctx(uid), { ...profileBase, name: "예약주인" });
    const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: 0, end: 1440 }));
    const page = await calendar.createBookingPage(ctx(uid), calendar.bookingPageInput.parse({ title: "30분 커피챗", windows: allDay, minNoticeMin: 60, horizonDays: 2, durationMin: 30 }));
    const token = page.url.split("/b/")[1]!;
    expect(page.url).toMatch(/^https:\/\/linkos\.test\/b\/[A-Za-z0-9_-]{32}$/);
    expect(await one("SELECT 1 FROM booking_pages WHERE token_hash=$1", [token])).toBeNull(); // only the hash is stored
    const first = await calendar.publicBookingPage(token);
    expect(first.ownerName).toBe("예약주인");
    expect(first.slots.length).toBeGreaterThan(10);
    g.busy.splice(0, g.busy.length, { start: first.slots[0]!.startsAt, end: first.slots[1]!.endsAt });
    const second = await calendar.publicBookingPage(token);
    expect(second.slots.map((s) => s.startsAt)).not.toContain(first.slots[0]!.startsAt);
    expect(second.slots.map((s) => s.startsAt)).not.toContain(first.slots[1]!.startsAt);
    const pick = second.slots[0]!;
    await expect(calendar.requestBooking(token, { startsAt: first.slots[0]!.startsAt, name: "게스트", email: "guest@x.io" }, "1.1.1.1")).rejects.toMatchObject({ code: "slot_unavailable" });
    const req = await calendar.requestBooking(token, { startsAt: pick.startsAt, name: "게스트", email: "guest@x.io", note: "제품 데모" }, "1.1.1.1");
    expect(req.status).toBe("pending_approval");
    expect(req.ics).toContain("STATUS:TENTATIVE");
    await expect(calendar.requestBooking(token, { startsAt: pick.startsAt, name: "다른 사람", email: "o@x.io" }, "1.1.1.2")).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(await one("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='booking.requested'", [uid])).toBeTruthy();
    g.busy.length = 0;
    const out = await calendar.decideCandidate(ctx(uid), req.requestId, calendar.decideInput.parse({ approve: true, notifyAttendees: true }));
    expect(out.calendarSync.status).toBe("done");
    const ev = g.events.get(req.requestId.replace(/-/g, ""))!;
    expect(ev.body.attendees).toEqual([{ email: "guest@x.io", displayName: "게스트" }]);
    expect(ev.sendUpdates).toBe("all");
    await calendar.updateBookingPage(ctx(uid), page.id, { active: false });
    await expect(calendar.publicBookingPage(token)).rejects.toMatchObject({ status: 404 });
  });
});

describe("F-157 Room 미팅 예약 · F-146 행사 미팅 요청", () => {
  it("room proposes slots for both parties; approving one supersedes the rest and logs in the room", async () => {
    const uid = (await user("room")).id;
    const a = await contact(uid, "에이", { email: "a@x.io" });
    const b = await contact(uid, "비", { email: "b@x.io" });
    const intro = await connection.createIntroduction(ctx(uid), { partyAContactId: a, partyBContactId: b, reason: "협업" });
    await connection.recordIntroConsent(ctx(uid), intro.id, "a", true);
    const roomId = (await connection.recordIntroConsent(ctx(uid), intro.id, "b", true)).roomId!;
    const t0 = Date.now() + 3 * 86400000;
    const cands = await calendar.proposeRoomMeeting(ctx(uid), roomId, calendar.roomMeetingInput.parse({ slots: [0, 1].map((i) => ({ startsAt: new Date(t0 + i * 86400000).toISOString(), endsAt: new Date(t0 + i * 86400000 + 1800000).toISOString() })) }));
    expect(cands).toHaveLength(2);
    expect(cands[0]!.attendees.map((x: any) => x.email).sort()).toEqual(["a@x.io", "b@x.io"]);
    expect(cands[0]!.title).toBe("에이 × 비 소개 미팅");
    await calendar.decideCandidate(ctx(uid), cands[1]!.id, calendar.decideInput.parse({ approve: true }));
    const all = await calendar.listCandidates(uid, { roomId });
    expect(all.map((c) => c.status)).toEqual(["approved"]);
    const room = await connection.getConnectionRoom(ctx(uid), roomId);
    expect(room.messages.at(-1).body).toMatch(/^미팅 확정/);
    const stranger = (await user("str")).id;
    await expect(calendar.proposeRoomMeeting(ctx(stranger), roomId, calendar.roomMeetingInput.parse({ slots: [{ startsAt: new Date(t0).toISOString(), endsAt: new Date(t0 + 1).toISOString() }] }))).rejects.toMatchObject({ status: 404 });
  });

  it("event attendees request 1:1 meetings; only opted-in targets; accept creates approved slots for both", async () => {
    const host = (await user("ehost")).id;
    const alice = (await user("ealice")).id;
    const bob = (await user("ebob")).id;
    const shy = (await user("eshy")).id;
    for (const [u, n] of [[host, "호스트"], [alice, "앨리스"], [bob, "밥"], [shy, "수줍"]] as const) await card.saveProfile(ctx(u), { ...profileBase, name: n });
    const ev = await event.createEvent(ctx(host), { name: "AI 서밋" });
    await event.joinEvent(ctx(alice), ev.joinCode, true);
    await event.joinEvent(ctx(bob), ev.joinCode, true);
    await event.joinEvent(ctx(shy), ev.joinCode, false);
    await connectGoogle(bob);
    const bobProfile = (await card.primaryProfileId(bob))!;
    const shyProfile = (await card.primaryProfileId(shy))!;
    const slots = [1, 2].map((h) => ({ startsAt: new Date(Date.now() + h * 3600000).toISOString(), endsAt: new Date(Date.now() + h * 3600000 + 1200000).toISOString() }));
    await expect(calendar.requestEventMeeting(ctx(alice), ev.id, calendar.eventMeetingInput.parse({ targetProfileId: shyProfile, slots }))).rejects.toMatchObject({ status: 404 });
    const r = await calendar.requestEventMeeting(ctx(alice), ev.id, calendar.eventMeetingInput.parse({ targetProfileId: bobProfile, slots, message: "부스 앞에서 10분?" }));
    await expect(calendar.requestEventMeeting(ctx(alice), ev.id, calendar.eventMeetingInput.parse({ targetProfileId: bobProfile, slots }))).rejects.toMatchObject({ code: "request_pending" });
    const incoming = await calendar.listEventMeetingRequests(ctx(bob), ev.id);
    expect(incoming[0]).toMatchObject({ direction: "incoming", counterpart: { name: "앨리스" }, status: "pending" });
    await expect(calendar.respondEventMeeting(ctx(alice), r.id, { accept: true, slotIndex: 0 })).rejects.toMatchObject({ status: 404 }); // only the target decides
    await calendar.respondEventMeeting(ctx(bob), r.id, { accept: true, slotIndex: 1 });
    const mine = await calendar.listCandidates(alice, { status: "approved" });
    expect(mine[0]).toMatchObject({ source: "event_request", title: "밥님과 1:1 · AI 서밋", attendees: [] });
    const bobs = await calendar.listCandidates(bob, { status: "approved" });
    expect(bobs[0]!.startsAt.toISOString()).toBe(slots[1]!.startsAt);
    expect(g.events.has(bobs[0]!.id.replace(/-/g, ""))).toBe(true); // Bob's Google Calendar got the event
    expect(await one("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event.meeting.accepted'", [alice])).toBeTruthy();
  });
});

describe("F-110 Web Push", () => {
  it("followup.due → outbox → push queue → encrypted Web Push (VAPID); gone subscriptions are removed", async () => {
    const uid = (await user("push")).id;
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    await push.subscribe(ctx(uid), { endpoint: `${pushSvc.url}/ok/1`, keys });
    await push.subscribe(ctx(uid), { endpoint: `${pushSvc.url}/gone/1`, keys });
    expect((await push.pushConfig(uid)).subscriptions).toHaveLength(2);
    await meeting.createFollowup(ctx(uid), meeting.followupInput.parse({ title: "제안서 회신", dueAt: new Date(Date.now() - 60000).toISOString() }));
    await processReminders();
    await relayOutbox();
    const n = await one<{ status: string }>("SELECT status FROM notifications WHERE user_id=$1 AND kind='followup.due'", [uid]);
    expect(n!.status).toBe("queued");
    expect(await push.processPushQueue()).toBeGreaterThanOrEqual(1);
    const got = pushSvc.received.find((r) => r.path === "/ok/1")!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(String(got.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(got.bytes).toBeGreaterThan(50);
    expect((await one<{ status: string }>("SELECT status FROM notifications WHERE user_id=$1 AND kind='followup.due'", [uid]))!.status).toBe("sent");
    expect((await push.pushConfig(uid)).subscriptions).toHaveLength(1); // 410 → removed
    await push.setPreferences(ctx(uid), { pushFollowups: false });
    await api.push.notify(api.pool(), uid, { kind: "followup.due", title: "x" });
    await push.processPushQueue();
    expect((await one<{ status: string; error: string }>("SELECT status, error FROM notifications WHERE user_id=$1 AND title='x'", [uid]))).toMatchObject({ status: "skipped", error: "preference_off" });
  });
});

describe("F-126 PDF · F-116 Google Drive", () => {
  it("PDF export embeds a Korean font; Drive saves into a reused LINKOS folder", async () => {
    const uid = (await user("pdf")).id;
    await contact(uid, "한글이름", { company: "가나다 주식회사", email: "k@x.io" });
    const job = await integration.createExport(ctx(uid), integration.exportInput.parse({ format: "pdf", fields: ["fullName", "company", "email"] }));
    const f = await integration.renderExport(ctx(uid), job.id);
    const buf = f.body as Buffer;
    expect(f.contentType).toBe("application/pdf");
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.toString("latin1")).toMatch(/\/BaseFont \/[A-Z]{6}\+Pretendard-Regular/);
    expect(buf.toString("latin1")).toContain("/FontFile2");
    await expect(integration.saveExportToDrive(ctx(uid), integration.driveSaveInput.parse({ format: "pdf", fields: ["fullName"] }))).rejects.toMatchObject({ code: "google_drive_not_connected" });
    await connectGoogle(uid);
    const a = await integration.saveExportToDrive(ctx(uid), integration.driveSaveInput.parse({ format: "pdf", fields: ["fullName", "company"] }));
    const b = await integration.saveExportToDrive(ctx(uid), integration.driveSaveInput.parse({ format: "csv", fields: ["fullName"] }));
    expect(a.folderId).toBe(b.folderId);
    const file = g.driveFiles.get(a.fileId)!;
    expect(file).toMatchObject({ parents: [a.folderId], mimeType: "application/pdf" });
    expect(file.content!.subarray(0, 5).toString()).toBe("%PDF-");
    expect(g.driveFiles.get(b.fileId)!.content!.toString()).toContain("한글이름");
    expect(a.url).toContain("drive.google.com");
    expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='export.google_drive'", [uid])).toBeTruthy();
  });
});

describe("F-119 Outlook/Microsoft", () => {
  let uid: string;
  let cid: string;
  it("OAuth (signed state) → sealed credentials, consent; contacts push + If-Match updates; conflict never overwritten", async () => {
    uid = (await user("ms")).id;
    expect(() => crm.verifyCrmState("abc.def")).toThrow();
    await connectCrm(uid, "microsoft");
    const acct = await one<{ encrypted_credentials: Buffer; metadata: any }>("SELECT encrypted_credentials, metadata FROM integration_accounts WHERE user_id=$1 AND provider='microsoft'", [uid]);
    expect(acct!.encrypted_credentials.toString()).not.toContain("ms-access");
    expect(acct!.metadata.accountEmail).toBe("owner@contoso.com");
    expect(await one("SELECT 1 FROM consent_records WHERE subject_user_id=$1 AND consent_type='integration_microsoft' AND granted", [uid])).toBeTruthy();
    cid = await contact(uid, "이서준", { company: "콘토소", email: "seojun@contoso.com", phone: "02-123-4567" });
    expect((await crm.enqueueCrmPush(ctx(uid), "microsoft", { object: "contact" })).queued).toBe(1);
    expect((await crm.enqueueCrmPush(ctx(uid), "microsoft", { object: "contact" })).queued).toBe(0);
    await integration.processSyncJobs();
    const [rec] = [...crmFake.ms.contacts.values()];
    expect(rec).toMatchObject({ givenName: "서준", surname: "이", companyName: "콘토소", emailAddresses: [{ address: "seojun@contoso.com", name: "이서준" }], businessPhones: ["02-123-4567"] });
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "팀장" });
    await relayOutbox(); // mapped records follow local edits
    await integration.processSyncJobs();
    expect(crmFake.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/graph/v1.0/me/contacts/")).at(-1)!.headers["if-match"]).toBeTruthy();
    expect(crmFake.ms.contacts.get(rec!.id)!.jobTitle).toBe("팀장");
    crmFake.ms.contacts.get(rec!.id)!["@odata.etag"] = 'W/"remote"';
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "본부장" });
    await relayOutbox();
    await integration.processSyncJobs();
    expect(crmFake.ms.contacts.get(rec!.id)!.jobTitle).toBe("팀장"); // not overwritten
    const j = await crm.syncJournal(uid, crm.journalQuery.parse({ provider: "microsoft" }));
    const conflictEntry = j.entries.find((e) => e.status === "conflict")!;
    expect(conflictEntry).toMatchObject({ canResolve: true, contact: { fullName: "이서준" } });
    expect(conflictEntry.external?.id).toBe(rec!.id);
    await crm.resolveConflict(ctx(uid), conflictEntry.id, "skip");
    expect((await one<{ status: string }>("SELECT status FROM sync_jobs WHERE id=$1", [conflictEntry.id]))!.status).toBe("skipped");
  });

  it("Outlook calendar for approved slots (transactionId) and Outlook mail send; Graph busy for booking", async () => {
    const r = await calendar.createCandidates(ctx(uid), calendar.manualCandidatesInput.parse({ title: "콘토소 미팅", contactId: cid, slots: [{ startsAt: new Date(Date.now() + 2 * 86400000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString() }] }));
    const out = await calendar.decideCandidate(ctx(uid), r[0]!.id, calendar.decideInput.parse({ approve: true }));
    expect(out.calendarSync).toMatchObject({ provider: "microsoft", status: "done" });
    const ev = [...crmFake.ms.events.values()].find((e) => e.transactionId === r[0]!.id)!;
    expect(ev.subject).toBe("콘토소 미팅");
    expect(ev.attendees).toEqual([]); // no invitations unless notifyAttendees
    crmFake.ms.busy.push({ start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 86400000 + 7200000).toISOString() });
    const busy = await calendar.busyIntervals(uid, new Date(), new Date(Date.now() + 3 * 86400000));
    expect(busy.source).toBe("microsoft");
    expect(busy.busy.length).toBeGreaterThanOrEqual(2);
    const m = await comms.createMessage(ctx(uid), comms.messageInput.parse({ contactId: cid, subject: "후속", body: "감사합니다" }));
    const sent = await comms.sendMessage(ctx(uid), m.id, { approved: true, via: "auto" });
    expect(sent).toMatchObject({ status: "sent", provider: "outlook" });
    expect(crmFake.ms.mail.at(-1)).toMatchObject({ saveToSentItems: true, message: { subject: "후속", toRecipients: [{ emailAddress: { address: "seojun@contoso.com" } }] } });
  });
});

describe("F-120 Salesforce · F-127 필드 매핑 · F-088 CRM 연결 · F-128 Sync Journal", () => {
  let uid: string;
  it("field mapping validation + storage; push contact; token refresh on 401; If-Unmodified-Since conflict", async () => {
    uid = (await user("sf")).id;
    await connectCrm(uid, "salesforce");
    expect((await one<{ metadata: any }>("SELECT metadata FROM integration_accounts WHERE user_id=$1 AND provider='salesforce'", [uid]))!.metadata.instanceUrl).toBe(`${crmFake.url}/sf`);
    await expect(crm.saveFieldMapping(ctx(uid), "salesforce", crm.mappingInput.parse({ object: "contact", entries: [{ local: "email", remote: "Email" }] }))).rejects.toMatchObject({ code: "invalid_mapping" });
    const saved = await crm.saveFieldMapping(ctx(uid), "salesforce", crm.mappingInput.parse({ object: "contact", entries: [{ local: "lastName", remote: "LastName" }, { local: "firstName", remote: "FirstName" }, { local: "email", remote: "Email" }, { local: "company", remote: "Company_Name__c" }] }));
    expect(saved.isDefault).toBe(false);
    const cid = await contact(uid, "Jane Doe", { company: "Acme", email: "jane@acme.io", jobTitle: "CTO" });
    await crm.enqueueCrmPush(ctx(uid), "salesforce", { object: "contact" });
    crmFake.sf.expireAccess();
    await integration.processSyncJobs();
    const rec = [...crmFake.sf.records.values()].find((r) => r.Email === "jane@acme.io")!;
    expect(rec).toMatchObject({ FirstName: "Jane", LastName: "Doe", Company_Name__c: "Acme" });
    expect(rec.Title).toBeUndefined(); // custom mapping decides which fields leave LINKOS
    expect(crmFake.calls.some((c) => c.path === "/sf/services/oauth2/token" && c.body.grant_type === "refresh_token")).toBe(true);
    const map = await one<{ external_id: string; external_etag: string; remote_url: string }>("SELECT external_id, external_etag, remote_url FROM external_mappings WHERE local_id=$1 AND entity_type='contact'", [cid]);
    expect(map).toMatchObject({ external_id: rec.Id, external_etag: rec.LastModifiedDate });
    crmFake.sf.touch(rec.Id);
    await relationship.updateContact(ctx(uid), cid, { email: "jane.doe@acme.io" });
    await relayOutbox();
    await integration.processSyncJobs();
    expect(rec.Email).toBe("jane@acme.io");
    const conflictJob = (await crm.syncJournal(uid, crm.journalQuery.parse({ status: "conflict" }))).entries[0]!;
    expect(conflictJob.provider).toBe("salesforce");
    await crm.resolveConflict(ctx(uid), conflictJob.id, "overwrite");
    expect(rec.Email).toBe("jane.doe@acme.io");
  });

  it("missing required fields fail loudly (dead) and can be retried after fixing; duplicates → conflict → link", async () => {
    const cid = await contact(uid, "No Company", { email: "nc@x.io" });
    await crm.enqueueCrmPush(ctx(uid), "salesforce", { object: "lead", contactIds: [cid] });
    await integration.processSyncJobs();
    const dead = (await crm.syncJournal(uid, crm.journalQuery.parse({ status: "dead" }))).entries[0]!;
    expect(dead).toMatchObject({ jobType: "crm.lead.upsert", canRetry: true });
    expect(dead.error).toContain("Company");
    await relationship.updateContact(ctx(uid), cid, { company: "NC Corp" });
    expect(await crm.retryJob(ctx(uid), dead.id)).toMatchObject({ status: "done" });
    expect([...crmFake.sf.records.values()].find((r) => r.type === "Lead")).toMatchObject({ Company: "NC Corp", LastName: "Company" });
    const dup = await contact(uid, "Dup Person", { email: "dup@sf.test" });
    await crm.enqueueCrmPush(ctx(uid), "salesforce", { object: "contact", contactIds: [dup] });
    await integration.processSyncJobs();
    const c = (await crm.syncJournal(uid, crm.journalQuery.parse({ status: "conflict" }))).entries[0]!;
    expect(c.external?.id).toBe("003EXISTING");
    crmFake.sf.records.set("003EXISTING", { Id: "003EXISTING", type: "Contact", LastName: "Old", LastModifiedDate: new Date().toISOString() });
    await crm.resolveConflict(ctx(uid), c.id, "overwrite");
    expect(crmFake.sf.records.get("003EXISTING")).toMatchObject({ LastName: "Person", Email: "dup@sf.test" });
  });

  it("external-id upsert is idempotent; F-088 meeting summary → Task on the contact (updated, not duplicated)", async () => {
    const u2 = (await user("sfx")).id;
    await connectCrm(u2, "salesforce");
    await crm.saveFieldMapping(ctx(u2), "salesforce", crm.mappingInput.parse({ object: "contact", entries: [{ local: "lastName", remote: "LastName" }, { local: "email", remote: "Email" }], externalIdField: "LINKOS_Id__c" }));
    const cid = await contact(u2, "Ext Id", { email: "ext@x.io" });
    await crm.enqueueCrmPush(ctx(u2), "salesforce", { object: "contact" });
    await integration.processSyncJobs();
    expect(crmFake.calls.some((c) => c.method === "PATCH" && c.path.includes(`/sobjects/Contact/LINKOS_Id__c/${cid}`))).toBe(true);
    expect([...crmFake.sf.records.values()].filter((r) => r.LINKOS_Id__c === cid)).toHaveLength(1);
    const mid = (await meeting.saveMeeting(ctx(u2), meeting.meetingInput.parse({ title: "QBR", participantContactIds: [cid], decisions: ["PoC 진행"], actionItems: [{ description: "견적 송부" }] }))).id;
    const r1 = await crm.attachMeetingToCrm(ctx(u2), mid, "salesforce");
    expect(r1).toMatchObject({ queued: 1, done: 1 });
    const tasks = () => [...crmFake.sf.records.values()].filter((r) => r.type === "Task");
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({ Subject: "LINKOS 미팅: QBR", Status: "Completed" });
    expect(tasks()[0]!.Description).toContain("결정: PoC 진행");
    expect(tasks()[0]!.Description).toContain("To-do: 견적 송부");
    expect(tasks()[0]!.WhoId).toMatch(/^003/);
    await crm.attachMeetingToCrm(ctx(u2), mid, "salesforce");
    expect(tasks()).toHaveLength(1); // re-attaching updates the same Task
  });
});

describe("F-121 HubSpot", () => {
  it("push contact, duplicate email → conflict with existing id, updatedAt-guarded update, notes associated (202)", async () => {
    const uid = (await user("hs")).id;
    await connectCrm(uid, "hubspot");
    const cid = await contact(uid, "Mina Park", { email: "mina@hub.io", company: "Hub" });
    await crm.enqueueCrmPush(ctx(uid), "hubspot", { object: "contact" });
    await integration.processSyncJobs();
    const rec = [...crmFake.hs.contacts.values()].find((c) => c.properties.email === "mina@hub.io")!;
    expect(rec.properties).toMatchObject({ firstname: "Mina", lastname: "Park", company: "Hub" });
    // another LINKOS contact with the same email → HubSpot 409 → conflict (no silent merge)
    const dupId = await contact(uid, "Mina P.", { email: "mina@hub.io" });
    await crm.enqueueCrmPush(ctx(uid), "hubspot", { object: "contact", contactIds: [dupId] });
    await integration.processSyncJobs();
    const c = (await crm.syncJournal(uid, crm.journalQuery.parse({ provider: "hubspot", status: "conflict" }))).entries[0]!;
    expect(c.external?.id).toBe(rec.id);
    // remote change → update blocked
    crmFake.hs.touch(rec.id);
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "PM" });
    await relayOutbox();
    await integration.processSyncJobs();
    expect(rec.properties.jobtitle).toBeUndefined();
    const mid = (await meeting.saveMeeting(ctx(uid), meeting.meetingInput.parse({ title: "킥오프", participantContactIds: [cid], decisions: ["주간 싱크"] }))).id;
    await crm.attachMeetingToCrm(ctx(uid), mid, "hubspot");
    const [note] = [...crmFake.hs.notes.values()];
    expect(note!.associations).toEqual([{ to: { id: rec.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }]);
    expect(note!.properties.hs_note_body).toContain("결정: 주간 싱크");
  });
});

describe("F-122 Dynamics 365", () => {
  it("requires a Dynamics org URL; creates with return=representation; If-Match etag; duplicate detection → conflict", async () => {
    const uid = (await user("dyn")).id;
    expect(() => crm.crmAuthUrl("dynamics", uid, {})).toThrow();
    expect(() => crm.crmAuthUrl("dynamics", uid, { orgUrl: "https://evil.example.com" })).toThrow();
    const { url } = crm.crmAuthUrl("dynamics", uid, { orgUrl: `${crmFake.url}/dyn` });
    expect(new URL(url).searchParams.get("scope")).toBe(`${crmFake.url}/dyn/user_impersonation offline_access`);
    await connectCrm(uid, "dynamics", { orgUrl: `${crmFake.url}/dyn` });
    const cid = await contact(uid, "박지민", { email: "jimin@dyn.io", phone: "010-1111-2222" });
    await crm.enqueueCrmPush(ctx(uid), "dynamics", { object: "contact" });
    await integration.processSyncJobs();
    const rec = [...crmFake.dyn.records.values()].find((r) => r.emailaddress1 === "jimin@dyn.io")!;
    expect(rec).toMatchObject({ firstname: "지민", lastname: "박", telephone1: "010-1111-2222" });
    expect(crmFake.calls.find((c) => c.method === "POST" && c.path === "/dyn/api/data/v9.2/contacts")!.headers.prefer).toBe("return=representation");
    crmFake.dyn.touch(rec.contactid);
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "매니저" });
    await relayOutbox();
    await integration.processSyncJobs();
    expect(rec.jobtitle).toBeUndefined();
    expect((await crm.syncJournal(uid, crm.journalQuery.parse({ status: "conflict" }))).entries).toHaveLength(1);
    const dup = await contact(uid, "중복", { email: "dup@dyn.test" });
    await crm.enqueueCrmPush(ctx(uid), "dynamics", { object: "contact", contactIds: [dup] });
    await integration.processSyncJobs();
    expect((await crm.syncJournal(uid, crm.journalQuery.parse({ status: "conflict" }))).entries).toHaveLength(2);
    const mid = (await meeting.saveMeeting(ctx(uid), meeting.meetingInput.parse({ title: "데모", participantContactIds: [cid] }))).id;
    await crm.attachMeetingToCrm(ctx(uid), mid, "dynamics");
    const ann = [...crmFake.dyn.records.values()].find((r) => r.set === "annotations")!;
    expect(ann[`objectid_contact@odata.bind`]).toBe(`/contacts(${rec.contactid})`);
    const status = await crm.crmStatus(uid);
    expect(status.find((s) => s.provider === "dynamics")).toMatchObject({ status: "active", configured: true });
  });
});

describe("F-123 Webhook/Zapier/Make", () => {
  it("signed deliveries for subscribed events only, retries with backoff, dead after non-retryable, test send", async () => {
    const uid = (await user("wh")).id;
    const other = (await user("wh2")).id;
    await expect(webhooks.createEndpoint(ctx(uid), webhooks.endpointInput.parse({ url: "ftp://x.io/hook", events: ["contact.updated"] }))).rejects.toMatchObject({ code: "invalid_webhook_url" });
    const ep = await webhooks.createEndpoint(ctx(uid), webhooks.endpointInput.parse({ url: `${hook.url}/zap`, events: ["contact.updated", "followup.due"] }));
    expect(ep.secret).toMatch(/^whsec_/);
    expect((await webhooks.listEndpoints(uid)).endpoints[0]).not.toHaveProperty("secret");
    const cid = await contact(uid, "웹훅");
    await relayOutbox();
    await webhooks.processWebhookDeliveries();
    expect(await webhooks.listDeliveries(ctx(uid), ep.id)).toMatchObject([{ event_type: "contact.updated", status: "delivered" }]);
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "x" });
    const otherCid = await contact(other, "남의 연락처");
    await relationship.updateContact(ctx(other), otherCid, { jobTitle: "y" });
    await relayOutbox();
    hook.statuses.push(503);
    await webhooks.processWebhookDeliveries();
    let d = (await webhooks.listDeliveries(ctx(uid), ep.id)) as any[];
    expect(d).toHaveLength(2); // the other user's events are not delivered here
    expect(d[0]).toMatchObject({ status: "retry", response_status: 503, attempt_count: 1 });
    expect(new Date(d[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20000);
    await q("UPDATE webhook_deliveries SET next_attempt_at=now() WHERE id=$1", [d[0].id]);
    await webhooks.processWebhookDeliveries();
    d = (await webhooks.listDeliveries(ctx(uid), ep.id)) as any[];
    expect(d[0]).toMatchObject({ status: "delivered", attempt_count: 2 });
    const last = hook.received.at(-1)!;
    const sig = String(last.headers["linkos-signature"]);
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(createHmac("sha256", ep.secret).update(`${t}.${last.body}`).digest("hex")).toBe(v1);
    expect(JSON.parse(last.body)).toMatchObject({ type: "contact.updated", data: { contact_id: cid } });
    expect(last.headers["linkos-event"]).toBe("contact.updated");
    // non-retryable → dead immediately; redeliver on demand
    await relationship.updateContact(ctx(uid), cid, { jobTitle: "z" });
    await relayOutbox();
    hook.statuses.push(400);
    await webhooks.processWebhookDeliveries();
    const deadOne = ((await webhooks.listDeliveries(ctx(uid), ep.id)) as any[]).find((x) => x.status === "dead");
    expect(deadOne).toMatchObject({ response_status: 400 });
    expect(await webhooks.redeliver(ctx(uid), deadOne.id)).toMatchObject({ status: "delivered" });
    // test send
    expect(await webhooks.testEndpoint(ctx(uid), ep.id)).toMatchObject({ status: "delivered", response_status: 200 });
    expect(JSON.parse(hook.received.at(-1)!.body).type).toBe("webhook.test");
    await expect(webhooks.testEndpoint(ctx(other), ep.id)).rejects.toMatchObject({ status: 404 });
    // rotate secret: new deliveries are signed with the new secret
    const rot = await webhooks.rotateSecret(ctx(uid), ep.id);
    await webhooks.testEndpoint(ctx(uid), ep.id);
    const l2 = hook.received.at(-1)!;
    const [, t2, s2] = String(l2.headers["linkos-signature"]).match(/^t=(\d+),v1=(.+)$/)!;
    expect(createHmac("sha256", rot.secret).update(`${t2}.${l2.body}`).digest("hex")).toBe(s2);
  });
});
