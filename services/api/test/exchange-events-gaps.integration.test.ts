// UI gap fill — API integration (real PostgreSQL, own database linkos_test_gaps):
// F-143 현장 교환(event-tagged exchange) · F-142 참가자 등록(CSV, owner session, idempotent, PII-free audit) ·
// F-147 booth staff from the attendee list · UX-015 recording markers · F-090 recording policy default · UX-020 room participants
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_gaps";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
delete process.env.ANTHROPIC_API_KEY;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { booth, card, connection, event, handoff, identity, meeting, relationship, q, one, closePool } = api;

const ctx = (userId: string | null, ip = "10.9.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
const stamp = Date.now();
let n = 0;
async function user(prefix = "gap", email?: string) {
  const addr = email ?? `${prefix}${stamp}-${n++}@gaps.test`;
  const { devCode } = await identity.requestOtp(ctx(null), addr);
  return { ...(await identity.verifyOtp(ctx(null), addr, devCode!, consents)).user, email: addr };
}
async function withCard(prefix: string, name: string, email?: string) {
  const u = await user(prefix, email);
  await card.saveProfile(ctx(u.id), { ...base, name });
  return u;
}
const guestReply = (name: string) => ({ card: { fullName: name, company: "게스트사", email: `${name.length}g${stamp}@guest.test` }, sharedFields: ["fullName", "company", "email"] as ("fullName" | "company" | "email")[], consent: { exchange: true as const }, provenance: {} });

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
  await closePool();
});

describe("F-143 현장 교환 — exchange tagged with an event", () => {
  it("tags the encounter with the event, defaults the place label, and refuses non-attendees", async () => {
    const owner = await withCard("evo", "주최자");
    const ev = await event.createEvent(ctx(owner.id), { name: "메디컬 엑스포 2026", venue: "코엑스" });
    const s = await handoff.createExchangeSession(ctx(owner.id), handoff.createSessionInput.parse({ capabilities: {}, context: { eventId: ev.id } }));
    expect(s).toMatchObject({ eventId: ev.id, placeLabel: "메디컬 엑스포 2026" });
    const landing = await handoff.openGuestLanding(s.token, ctx(null), "anon");
    expect(landing.placeLabel).toBe("메디컬 엑스포 2026");
    await handoff.replyExchange(s.token, ctx(null), handoff.replyInput.parse(guestReply("현장게스트")));
    const enc = await one<{ event_id: string; place_label: string }>("SELECT event_id, place_label FROM encounters WHERE exchange_session_id=$1 AND owner_user_id=$2", [s.sessionId, owner.id]);
    expect(enc).toMatchObject({ event_id: ev.id, place_label: "메디컬 엑스포 2026" });
    const detail = await event.getEvent(ctx(owner.id), ev.id);
    expect(detail.leads.map((l) => l.fullName)).toContain("현장게스트");

    // an explicit place label wins over the event name
    const s2 = await handoff.createExchangeSession(ctx(owner.id), handoff.createSessionInput.parse({ capabilities: {}, context: { eventId: ev.id, placeLabel: "B홀 부스" } }));
    expect(s2.placeLabel).toBe("B홀 부스");

    // someone who never joined the event cannot tag exchanges with it
    const outsider = await withCard("evx", "외부인");
    await expect(handoff.createExchangeSession(ctx(outsider.id), handoff.createSessionInput.parse({ capabilities: {}, context: { eventId: ev.id } }))).rejects.toMatchObject({ status: 404 });
  });

  it("a signed-in receiver who attends the same event gets an event-tagged encounter too", async () => {
    const owner = await withCard("evs", "보내는사람");
    const ev = await event.createEvent(ctx(owner.id), { name: "스타트업 데모데이" });
    const fetched = await one<{ join_code: string }>("SELECT join_code FROM events WHERE id=$1", [ev.id]);
    const rx = await withCard("evr", "받는사람");
    await event.joinEvent(ctx(rx.id), fetched!.join_code, true);
    const s = await handoff.createExchangeSession(ctx(owner.id), handoff.createSessionInput.parse({ capabilities: {}, context: { eventId: ev.id } }));
    const r = await handoff.replyExchange(s.token, ctx(rx.id), handoff.replyInput.parse(guestReply("받는사람")));
    const enc = await one<{ event_id: string | null }>("SELECT event_id FROM encounters WHERE contact_id=$1 AND owner_user_id=$2", [r.receiverContactId, rx.id]);
    expect(enc?.event_id).toBe(ev.id);
  });
});

describe("F-142 참가자 등록 (organizer session API)", () => {
  it("imports CSV idempotently, keeps PII out of the audit log, and links pre-registered people when they join", async () => {
    const owner = await withCard("reg", "행사주최");
    const ev = await event.createEvent(ctx(owner.id), { name: "등록 테스트 행사" });
    const joinerEmail = `prereg${stamp}@gaps.test`;
    const csv = `이름,이메일,회사,직책\n김사전,${joinerEmail.toUpperCase()},사전회사,팀장\n박참가,park${stamp}@gaps.test,참가사,매니저\n이메일없음,,무메일사,\n,nobody@gaps.test,,\n`;
    const r1 = await event.importAttendees(ctx(owner.id), ev.id, event.attendeeImportInput.parse({ csv }));
    expect(r1).toMatchObject({ inserted: 3, updated: 0, skipped: 1 });
    expect(r1.errors).toEqual([{ line: 5, reason: "missing_name" }]);

    // same list again (e.g. a retried upload) → no duplicates
    const r2 = await event.importAttendees(ctx(owner.id), ev.id, event.attendeeImportInput.parse({ csv }));
    expect(r2).toMatchObject({ inserted: 0, updated: 3 });
    // structured rows (paste preview) use the same keys
    const r3 = await event.importAttendees(ctx(owner.id), ev.id, event.attendeeImportInput.parse({ attendees: [{ fullName: "박참가", email: `park${stamp}@gaps.test`, company: "참가사(변경)" }], source: "paste" }));
    expect(r3).toMatchObject({ inserted: 0, updated: 1 });

    const list = await event.listAttendees(ctx(owner.id), ev.id);
    const registered = list.filter((a) => a.status === "registered");
    expect(registered.map((a) => a.fullName).sort()).toEqual(["김사전", "박참가", "이메일없음"]);
    expect(registered.find((a) => a.fullName === "박참가")?.company).toBe("참가사(변경)");
    expect(registered.find((a) => a.fullName === "김사전")?.email).toBe(joinerEmail);

    // audit trail carries counts only
    const audits = await q<{ metadata: unknown }>("SELECT metadata FROM audit_logs WHERE entity_id=$1 AND action='event.attendees_imported'", [ev.id]);
    expect(audits).toHaveLength(3);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain("@gaps.test");
    expect(dump).not.toContain("김사전");

    // pre-registered counts are separate from joined attendees; registrants are never match candidates
    let detail = await event.getEvent(ctx(owner.id), ev.id);
    expect(detail).toMatchObject({ attendees: 1, registered: 3 });

    // the pre-registered person joins with the code → their row is claimed (no duplicate)
    const joiner = await withCard("join", "김사전", joinerEmail);
    await event.joinEvent(ctx(joiner.id), detail.joinCode, true);
    detail = await event.getEvent(ctx(owner.id), ev.id);
    expect(detail).toMatchObject({ attendees: 2, registered: 3, optedIn: 2 });
    const after = await event.listAttendees(ctx(owner.id), ev.id);
    expect(after.find((a) => a.userId === joiner.id)).toMatchObject({ status: "joined", preRegistered: true });
    expect(after).toHaveLength(4); // owner + 3 registrants (one now joined)

    // F-147: the owner can make a joined attendee booth staff via /events/{id}/team
    await booth.setStaff(ctx(owner.id), ev.id, joiner.id, true);
    expect((await booth.listTeam(ctx(owner.id), ev.id)).map((t) => t.user_id)).toContain(joiner.id);
    await booth.setStaff(ctx(owner.id), ev.id, joiner.id, false);
    expect((await booth.listTeam(ctx(owner.id), ev.id)).map((t) => t.user_id)).not.toContain(joiner.id);

    // remove a registrant that has not joined; a joined one cannot be removed this way
    const toRemove = after.find((a) => a.fullName === "이메일없음")!;
    await expect(event.removeRegistrant(ctx(owner.id), ev.id, toRemove.id)).resolves.toEqual({ removed: true });
    await expect(event.removeRegistrant(ctx(owner.id), ev.id, after.find((a) => a.userId === joiner.id)!.id)).rejects.toMatchObject({ status: 404 });

    // only the owner — attendees and outsiders are refused
    await expect(event.importAttendees(ctx(joiner.id), ev.id, event.attendeeImportInput.parse({ csv }))).rejects.toMatchObject({ status: 403 });
    await expect(event.listAttendees(ctx(joiner.id), ev.id)).rejects.toMatchObject({ status: 403 });
    await expect(event.importAttendees(ctx(owner.id), ev.id, event.attendeeImportInput.parse({ csv: "회사\n무명사" }))).rejects.toMatchObject({ code: "no_attendees" });
  });
});

describe("UX-015 recording markers + F-090 recording policy", () => {
  it("stores markers with an offset and returns them in the meeting detail", async () => {
    const u = await withCard("mk", "녹음자");
    const m = await meeting.saveMeeting(ctx(u.id), meeting.meetingInput.parse({ title: "마커 미팅" }));
    expect(m.recordingPolicy).toEqual({ policy: "all_party", locked: false, source: "default" });
    await meeting.setRecordingConsent(ctx(u.id), m.id, { ownerConsent: true, participantsAcknowledged: true, policy: "all_party" });
    const rec = await meeting.createRecording(ctx(u.id), m.id, { mimeType: "audio/webm" });
    const a = await meeting.addMarker(ctx(u.id), m.id, meeting.markerInput.parse({ recordingId: rec.id, offsetMs: 12_345, label: "가격 이야기" }));
    expect(a).toMatchObject({ recordingId: rec.id, offsetMs: 12_345, label: "가격 이야기" });
    await meeting.addMarker(ctx(u.id), m.id, meeting.markerInput.parse({ recordingId: rec.id, offsetMs: 30_000 }));
    const detail = await meeting.getMeeting(u.id, m.id);
    expect(detail.markers.map((x) => [x.offsetMs, x.label])).toEqual([
      [12_345, "가격 이야기"],
      [30_000, null],
    ]);
    expect(await meeting.listMarkers(ctx(u.id), m.id)).toHaveLength(2);

    // another meeting's recording, or someone else's meeting, is refused
    const other = await meeting.saveMeeting(ctx(u.id), meeting.meetingInput.parse({ title: "다른 미팅" }));
    await expect(meeting.addMarker(ctx(u.id), other.id, meeting.markerInput.parse({ recordingId: rec.id, offsetMs: 1 }))).rejects.toMatchObject({ code: "invalid_recording" });
    const stranger = await withCard("mks", "남");
    await expect(meeting.addMarker(ctx(stranger.id), m.id, meeting.markerInput.parse({ offsetMs: 1 }))).rejects.toMatchObject({ status: 404 });
    await expect(meeting.listMarkers(ctx(stranger.id), m.id)).rejects.toMatchObject({ status: 404 });
  });

  it("preselects the meeting's recorded policy; one-party notice still requires the owner's consent record", async () => {
    const u = await withCard("pol", "정책");
    const m = await meeting.saveMeeting(ctx(u.id), meeting.meetingInput.parse({ title: "정책 미팅" }));
    const denied = await meeting.setRecordingConsent(ctx(u.id), m.id, { ownerConsent: false, participantsAcknowledged: false, policy: "one_party_notice" });
    expect(denied.consentStatus).toBe("denied");
    await expect(meeting.createRecording(ctx(u.id), m.id)).rejects.toMatchObject({ code: "recording_consent_required" });
    const ok = await meeting.setRecordingConsent(ctx(u.id), m.id, { ownerConsent: true, participantsAcknowledged: false, policy: "one_party_notice" });
    expect(ok.consentStatus).toBe("granted");
    expect((await meeting.getMeeting(u.id, m.id)).recordingPolicy).toEqual({ policy: "one_party_notice", locked: false, source: "meeting" });
    const consentRows = await q("SELECT 1 FROM consent_records WHERE subject_user_id=$1 AND consent_type='recording'", [u.id]);
    expect(consentRows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("UX-020 connection room participants", () => {
  it("lists the introducer and both parties with roles and titles", async () => {
    const u = await withCard("room", "소개자");
    const a = await relationship.createContact(ctx(u.id), { fullName: "에이", company: "A사", jobTitle: "CTO", source: "manual", provenance: {} });
    const b = await relationship.createContact(ctx(u.id), { fullName: "비", company: "B사", source: "manual", provenance: {} });
    const intro = await connection.createIntroduction(ctx(u.id), { partyAContactId: a.contactId, partyBContactId: b.contactId, reason: "협업 가능성" });
    await connection.recordIntroConsent(ctx(u.id), intro.id, "a", true);
    const done = await connection.recordIntroConsent(ctx(u.id), intro.id, "b", true);
    const room = await connection.getConnectionRoom(ctx(u.id), done.roomId);
    expect(room.participants).toEqual([
      expect.objectContaining({ role: "introducer", name: "소개자" }),
      expect.objectContaining({ role: "party_a", name: "에이", company: "A사", jobTitle: "CTO", status: "accepted" }),
      expect.objectContaining({ role: "party_b", name: "비", company: "B사", jobTitle: null }),
    ]);
    const stranger = await withCard("rooms", "남");
    await expect(connection.getConnectionRoom(ctx(stranger.id), done.roomId)).rejects.toMatchObject({ status: 404 });
  });
});
