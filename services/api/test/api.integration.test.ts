// Integration tests against a real PostgreSQL (DATABASE_URL, default linkos_test).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox, tick } = await import("../src/worker");
const { ai, analytics, capture, card, connection, event, handoff, identity, integration, meeting, relationship, security, closePool, q, one } = api;

const ctx = (userId: string | null, ip = "10.0.0.1") => ({ userId, ip, userAgent: "Mozilla/5.0 (iPhone) Safari/605", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];

async function signUp(email: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  const r = await identity.verifyOtp(ctx(null), email, devCode!, consents);
  return r;
}

const baseProfile = {
  company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
  theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [],
};

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, exchange_sessions, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes, events, deletion_requests CASCADE");
});
afterAll(async () => {
  await closePool();
});

describe("F-001/F-007/F-009 identity", () => {
  it("requires mandatory consents for signup and rotates sessions", async () => {
    const { devCode } = await identity.requestOtp(ctx(null), "noconsent@test.io");
    await expect(identity.verifyOtp(ctx(null), "noconsent@test.io", devCode!, [])).rejects.toMatchObject({ code: "consent_required" });
    const { devCode: c2 } = await identity.requestOtp(ctx(null), "noconsent@test.io");
    await expect(identity.verifyOtp(ctx(null), "noconsent@test.io", "000000" === c2 ? "111111" : "000000", consents)).rejects.toMatchObject({ code: "invalid_code" });

    const { user, sessionToken, isNew } = await signUp("alice@test.io");
    expect(isNew).toBe(true);
    const s = await identity.resolveSession(sessionToken, ctx(null));
    expect(s?.userId).toBe(user.id);
    const stored = await q<{ refresh_hash: string }>("SELECT refresh_hash FROM auth_sessions WHERE user_id=$1", [user.id]);
    expect(stored.every((r) => r.refresh_hash !== sessionToken)).toBe(true);

    // force rotation, then reuse of the old token revokes the family
    await q("UPDATE auth_sessions SET last_used_at = now() - interval '2 hours' WHERE user_id=$1", [user.id]);
    const rotated = await identity.resolveSession(sessionToken, ctx(null));
    expect(rotated?.rotatedToken).toBeTruthy();
    expect(await identity.resolveSession(sessionToken, ctx(null))).toBeNull();
    expect(await identity.resolveSession(rotated!.rotatedToken!, ctx(null))).toBeNull();
  });
});

describe("Guest Exchange → Claim (F-002, F-003, F-037~F-064)", () => {
  let sender: { id: string };
  let token: string;
  let sessionId: string;
  let claimToken: string;

  it("sender creates a Living Card with field ACL", async () => {
    const r = await signUp("sender@test.io");
    sender = r.user;
    const p = await card.saveProfile(ctx(sender.id), {
      ...baseProfile,
      name: "홍길동",
      company: "링코스랩",
      jobTitle: "대표",
      keywords: ["의료AI", "B2B", "SaaS"],
      fields: [
        { type: "email", value: "hong@linkos.ai", visibility: "business" },
        { type: "mobile", value: "010-1234-5678", visibility: "trusted" },
        { type: "website", value: "linkos.ai", visibility: "public" },
        { type: "other", label: "개인메모", value: "secret", visibility: "private" },
      ],
      offers: ["의료 영상 AI 솔루션"],
      needs: ["병원 유통 파트너"],
    });
    expect(p.version).toBe(1);
  });

  it("creates an exchange session: token is hashed, ladder ends in QR, no PII in token", async () => {
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: { webShare: true }, group: false, context: { placeLabel: "COEX" } });
    token = s.token;
    sessionId = s.sessionId;
    expect(s.channelPlan[0]).toBe("os_share");
    expect(s.channelPlan.at(-1)).toBe("qr");
    expect(s.url).toBe(`https://linkos.test/x/${token}`);
    expect(s.shortCode).toMatch(/^[2-9A-Z]{6}$/);
    const row = await one<{ token_hash: string }>("SELECT token_hash FROM exchange_sessions WHERE id=$1", [sessionId]);
    expect(row!.token_hash).not.toBe(token);
    expect(token).not.toMatch(/hong|010|linkos/i);
  });

  it("F-048 failed channels advance to QR automatically", async () => {
    const a = await handoff.recordAttempt(ctx(sender.id), sessionId, "os_share", "cancelled", 1200);
    expect(a.nextChannel).toBe("short_code");
    const b = await handoff.recordAttempt(ctx(sender.id), sessionId, "short_code", "timeout", 45000);
    expect(b.nextChannel).toBe("qr");
  });

  it("F-053 guest sees the card without login; ACL hides trusted/private fields", async () => {
    const landing = await handoff.openGuestLanding(token, ctx(null, "10.0.0.9"), "anon-1");
    expect(landing.sender.name).toBe("홍길동");
    expect(landing.acceptsReply).toBe(true);
    const types = landing.sender.fields.map((f) => f.type);
    expect(types).toContain("email");
    expect(types).not.toContain("mobile");
    expect(JSON.stringify(landing)).not.toContain("secret");
    expect(landing.sender.hiddenFields).toBe(1);
    // short code resolves to the same session
    const st = await handoff.getSenderSessionStatus(ctx(sender.id), sessionId);
    expect(st.state).toBe("RECEIVER_OPENED");
  });

  it("guest replies with OCR card — only approved fields are shared, both-side records created", async () => {
    const r = await handoff.replyExchange(token, ctx(null, "10.0.0.9"), {
      card: { fullName: "김영희", company: "메디파트너스", jobTitle: "이사", email: "yh@medi.kr", phone: "010-9999-8888" },
      sharedFields: ["fullName", "company", "jobTitle", "email"],
      consent: { exchange: true },
      provenance: { fullName: { source: "ocr", confidence: 0.92 }, email: { source: "user" } },
      ocr: { lines: [{ text: "김영희 이사", confidence: 92 }, { text: "yh@medi.kr", confidence: 95 }] },
      offer: "전국 병원 유통망",
      need: "의료 AI 제품",
    });
    expect(r.exchanged).toBe(true);
    expect(r.claimToken).toBeTruthy();
    claimToken = r.claimToken!;
    const contacts = await relationship.listContacts(sender.id);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.fullName).toBe("김영희");
    expect(contacts[0]!.phone).toBeNull(); // not approved for sharing
    expect(contacts[0]!.provenance).toMatchObject({ fullName: { source: "ocr", confidence: 0.92 } });
    const st = await handoff.getSenderSessionStatus(ctx(sender.id), sessionId);
    expect(st.state).toBe("CLAIM_PENDING");
    expect(st.received[0]?.fullName).toBe("김영희");
    // single-use link
    await expect(handoff.replyExchange(token, ctx(null), { card: { fullName: "X" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} })).rejects.toMatchObject({ code: "already_exchanged" });
    // follow-up suggested as draft (never auto-sent)
    const fu = await meeting.listFollowups(sender.id);
    expect(fu[0]?.source).toBe("ai_suggested");
  });

  it("outbox events were written in the same transaction", async () => {
    const types = (await q<{ event_type: string }>("SELECT event_type FROM outbox_events ORDER BY created_at")).map((r) => r.event_type);
    for (const t of ["exchange.session.created", "exchange.channel.attempted", "exchange.receiver.opened", "exchange.completed", "card.extraction.completed", "contact.updated"]) expect(types).toContain(t);
    // match a real phone number, not any "010-" substring (UUIDs such as …-4010-… contain one)
    const leaked = await q("SELECT 1 FROM outbox_events WHERE payload::text ILIKE '%yh@medi.kr%' OR payload::text ~ '(^|[^0-9a-fA-F])01[016789]-?[0-9]{3,4}-?[0-9]{4}([^0-9]|$)'");
    expect(leaked).toHaveLength(0);
    expect(await relayOutbox()).toBeGreaterThan(0);
  });

  it("F-003 claim after signup: guest gets profile + reverse relationship without data loss", async () => {
    const preview = await handoff.previewClaim(claimToken);
    expect(preview.guest.fullName).toBe("김영희");
    const guest = await signUp("yh@medi.kr");
    const r = await handoff.claimGuest(ctx(guest.user.id), claimToken);
    expect(r.claimed).toBe(true);
    const myProfile = await card.loadProfile(r.profileId!);
    expect(myProfile?.name).toBe("김영희");
    expect(myProfile?.offers.map((o) => o.text)).toEqual(["전국 병원 유통망"]);
    const theirContacts = await relationship.listContacts(guest.user.id);
    expect(theirContacts[0]?.fullName).toBe("홍길동");
    expect(theirContacts[0]?.linkedUserId).toBe(sender.id);
    const senderContact = (await relationship.listContacts(sender.id))[0]!;
    expect(senderContact.linkedUserId).toBe(guest.user.id);
    const st = await handoff.getSenderSessionStatus(ctx(sender.id), sessionId);
    expect(st.state).toBe("CLAIMED");
    // idempotent re-claim, other user rejected
    expect((await handoff.claimGuest(ctx(guest.user.id), claimToken)).alreadyClaimed).toBe(true);
    const other = await signUp("other@test.io");
    await expect(handoff.claimGuest(ctx(other.user.id), claimToken)).rejects.toMatchObject({ code: "already_claimed" });

    // Need↔Offer match now available between the two (explainable, ai_inferred)
    const m = await ai.listMatches(ctx(sender.id));
    expect(m.results[0]?.candidateName).toBe("김영희");
    expect(m.results[0]?.provenance).toBe("ai_inferred");
    expect(m.results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("expired and revoked links are refused", async () => {
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: false, context: {} });
    await q("UPDATE exchange_sessions SET expires_at = now() - interval '1 minute' WHERE id=$1", [s.sessionId]);
    await expect(handoff.openGuestLanding(s.token, ctx(null), "a")).rejects.toMatchObject({ code: "exchange_expired" });
    const s2 = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: false, context: {} });
    await handoff.revokeSession(ctx(sender.id), s2.sessionId);
    await expect(handoff.openGuestLanding(s2.token, ctx(null), "a")).rejects.toMatchObject({ code: "exchange_revoked" });
    await expect(handoff.openGuestLanding("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ctx(null), "a")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reply without opening the landing first (API/native client) still completes", async () => {
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: false, context: {} });
    const r = await handoff.replyExchange(s.token, ctx(null), { card: { fullName: "직접회신" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} });
    expect(r.exchanged).toBe(true);
    const st = await handoff.getSenderSessionStatus(ctx(sender.id), s.sessionId);
    expect(st.state).toBe("CLAIM_PENDING");
    expect(st.receiverOpenedAt).toBeTruthy();
  });

  it("F-051 group exchange accepts multiple replies", async () => {
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: true, maxUses: 3, context: {} });
    for (const n of ["A", "B"]) {
      await handoff.replyExchange(s.shortCode!, ctx(null), { card: { fullName: `참가자${n}` }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} });
    }
    const st = await handoff.getSenderSessionStatus(ctx(sender.id), s.sessionId);
    expect(st.useCount).toBe(2);
    expect(st.received).toHaveLength(2);
  });
});

describe("capture, duplicates, merge (F-010~F-021)", () => {
  it("parses OCR lines, flags duplicates, merges with undo", async () => {
    const u = (await signUp("cap@test.io")).user;
    const first = await relationship.createContact(ctx(u.id), { fullName: "박민수", company: "에이스테크", email: "ms@ace.io", source: "manual", provenance: {} });
    const job = await capture.captureBusinessCard(ctx(u.id), {
      side: "front", kind: "card", engine: "test",
      lines: [{ text: "에이스테크 주식회사", confidence: 90 }, { text: "박민수 팀장", confidence: 93 }, { text: "ms@ace.io", confidence: 96 }, { text: "M. 010-2222-3333", confidence: 91 }],
    });
    expect(job.draft.fullName).toBe("박민수");
    expect(job.draft.mobile).toBe("010-2222-3333");
    expect(job.duplicates[0]?.contactId).toBe(first.contactId);
    expect(job.duplicates[0]?.autoMergeable).toBe(true);
    const second = await relationship.createContact(ctx(u.id), { fullName: job.draft.fullName!, company: job.draft.company, jobTitle: job.draft.jobTitle, email: job.draft.email, phone: job.draft.mobile, source: "scan", provenance: {}, businessCardId: job.id });
    const merged = await relationship.mergeContact(ctx(u.id), first.contactId, second.contactId, { jobTitle: "secondary" });
    expect(merged.jobTitle).toBe("팀장");
    expect(merged.phone).toBe("010-2222-3333");
    expect(await relationship.listContacts(u.id)).toHaveLength(1);
    const undone = await relationship.undoMerge(ctx(u.id), first.contactId);
    expect(undone.primary.jobTitle).toBeNull();
    expect(await relationship.listContacts(u.id)).toHaveLength(2);
  });

  it("optimistic version conflict on concurrent edits", async () => {
    const u = (await signUp("ver@test.io")).user;
    const c = await relationship.createContact(ctx(u.id), { fullName: "이도윤", source: "manual", provenance: {} });
    await relationship.updateContact(ctx(u.id), c.contactId, { jobTitle: "CTO", version: 1 });
    await expect(relationship.updateContact(ctx(u.id), c.contactId, { jobTitle: "CEO", version: 1 })).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("tenant isolation: another user cannot read or edit my contacts", async () => {
    const a = (await signUp("iso-a@test.io")).user;
    const b = (await signUp("iso-b@test.io")).user;
    const c = await relationship.createContact(ctx(a.id), { fullName: "비밀", source: "manual", provenance: {} });
    await expect(relationship.getContactRow(b.id, c.contactId)).rejects.toMatchObject({ status: 404 });
    await expect(relationship.updateContact(ctx(b.id), c.contactId, { fullName: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(relationship.addNote(ctx(b.id), c.contactId, "x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("meetings, search, intro, events, export, privacy", () => {
  it("meeting card + recording consent gate + brief + memory search", async () => {
    const u = (await signUp("meet@test.io")).user;
    await card.saveProfile(ctx(u.id), { ...baseProfile, name: "나" });
    const c = await relationship.createContact(ctx(u.id), { fullName: "최의료", company: "헬스AI", jobTitle: "대표", source: "manual", provenance: {}, encounter: { placeLabel: "코엑스 메디컬 엑스포" } });
    await relationship.addNote(ctx(u.id), c.contactId, "의료 AI 영상판독 투자 관심");
    const m = await meeting.saveMeeting(ctx(u.id), {
      title: "헬스AI 미팅", purpose: "파일럿 논의", participantContactIds: [c.contactId], discussion: ["파일럿 범위"], decisions: ["3개 병원 파일럿"],
      promises: [{ text: "제안서 송부", by: "me" }], actionItems: [{ description: "제안서 송부", contactId: c.contactId, status: "open" }],
    });
    expect(m.decisions).toEqual(["3개 병원 파일럿"]);
    expect(m.actionItems).toHaveLength(1);
    await expect(meeting.createRecording(ctx(u.id), m.id)).rejects.toMatchObject({ code: "recording_consent_required" });
    const consent = await meeting.setRecordingConsent(ctx(u.id), m.id, { ownerConsent: true, participantsAcknowledged: false, policy: "all_party" });
    expect(consent.consentStatus).toBe("denied");
    const brief = await meeting.getMeetingBrief(ctx(u.id), m.id);
    expect(brief.people[0]?.openActions[0]?.description).toBe("제안서 송부");
    const s = await ai.relationshipSearch(ctx(u.id), "코엑스에서 만난 의료 AI 대표");
    expect(s.results[0]?.fullName).toBe("최의료");
    expect(s.results[0]?.evidence.length).toBeGreaterThan(0);
  });

  it("consent-based introduction creates a room only after both accept", async () => {
    const u = (await signUp("intro@test.io")).user;
    const a = await relationship.createContact(ctx(u.id), { fullName: "A", source: "manual", provenance: {} });
    const b = await relationship.createContact(ctx(u.id), { fullName: "B", source: "manual", provenance: {} });
    const i = await connection.createIntroduction(ctx(u.id), { partyAContactId: a.contactId, partyBContactId: b.contactId, reason: "투자-스타트업 연결" });
    expect(i.contactsRevealed).toBe(false);
    const i2 = await connection.recordIntroConsent(ctx(u.id), i.id, "a", true);
    expect(i2.roomId).toBeNull();
    const i3 = await connection.recordIntroConsent(ctx(u.id), i.id, "b", true);
    expect(i3.state).toBe("ROOM_CREATED");
    const room = await connection.getConnectionRoom(ctx(u.id), i3.roomId!);
    expect(room.messages[0]?.body).toContain("투자-스타트업");
  });

  it("event networking only matches opted-in attendees", async () => {
    const host = (await signUp("host@test.io")).user;
    await card.saveProfile(ctx(host.id), { ...baseProfile, name: "호스트", needs: ["시리즈A 투자"] });
    const vc = (await signUp("vc@test.io")).user;
    await card.saveProfile(ctx(vc.id), { ...baseProfile, name: "투자자", offers: ["시리즈A 투자 집행"] });
    const shy = (await signUp("shy@test.io")).user;
    await card.saveProfile(ctx(shy.id), { ...baseProfile, name: "비공개", offers: ["시리즈A 투자"] });
    const e = await event.createEvent(ctx(host.id), { name: "Demo Day" });
    await event.joinEvent(ctx(vc.id), e.joinCode, true);
    await event.joinEvent(ctx(shy.id), e.joinCode, false);
    const m = await event.eventMatches(ctx(host.id), e.id);
    expect(m.results.map((r) => r.candidateName)).toEqual(["투자자"]);
  });

  it("export respects selected fields; privacy export + deletion", async () => {
    const u = (await signUp("exp@test.io")).user;
    await relationship.createContact(ctx(u.id), { fullName: "=cmd()", email: "e@x.io", phone: "010-1", source: "manual", provenance: {} });
    const job = await integration.createExport(ctx(u.id), { format: "csv", fields: ["fullName", "email"] });
    const out = await integration.renderExport(ctx(u.id), job.id);
    expect(String(out.body)).toContain("'=cmd()");
    expect(String(out.body)).not.toContain("010-1");
    const x = await integration.renderExport(ctx(u.id), (await integration.createExport(ctx(u.id), { format: "xlsx", fields: ["fullName"] })).id);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    const data = await security.exportMyData(ctx(u.id));
    expect(data.contacts).toHaveLength(1);
    const del = await security.requestDeletion(ctx(u.id));
    expect(del.status).toBe("scheduled");
    await q("UPDATE deletion_requests SET deadline = now() - interval '1 second' WHERE id=$1", [del.id]);
    await tick();
    expect(await one("SELECT 1 FROM users WHERE id=$1", [u.id])).toBeNull();
    expect(await q("SELECT 1 FROM contacts WHERE owner_user_id=$1", [u.id])).toHaveLength(0);
  });

  it("KPIs compute funnel rates", async () => {
    const k = await analytics.exchangeKpis(null, 30);
    expect(k.funnel.created).toBeGreaterThan(0);
    expect(k.channels.length).toBeGreaterThan(0);
  });
});
