// QA (table-driven) against the real DB: authz across tenants, malformed ids, request validation, idempotency replays,
// and "private notes never leak" through any read path (CLAUDE.md §3). Every op is attempted by
//   B (another user) · anonymous · A with a malformed id · A with an unknown uuid
// and must end in a 4xx ApiError — never success, never a raw DB error (which the route layer turns into a 500).
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantSeats } from "./seats";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { ApiError, ai, capture, card, comms, connection, event, files, handoff, identity, inbox, integration, intro, living, meeting, network, org, recording, relationship, security, closePool, q, withIdempotency } = api;
const { assist } = api;

type Ctx = { userId: string | null; ip: string; userAgent: string; requestId: string };
const ctx = (userId: string | null): Ctx => ({ userId, ip: `10.9.${Math.floor(Math.random() * 250)}.1`, userAgent: "qa", requestId: "qa" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
const RUN = Date.now().toString(36);

async function signUp(tag: string) {
  const email = `${tag}-${RUN}@qa.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}

const baseProfile = {
  company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
  theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [],
};

const PRIVATE = `PRIVNOTE-${RUN}-연봉협상`;

interface Fx {
  A: string; B: string; C: string;
  contactA: string; contactB: string; contactA2: string; meetingA: string; followupA: string; sessionA: string; introA: string; roomA: string;
  eventA: string; exportA: string; templateA: string; messageA: string; sequenceA: string; orgA: string; teamNoteA: string; profileA: string;
  profileB: string; cardA: string; accessReqA: string; actionReqA: string; notificationA: string | null; inviteA: string;
}
const fx = {} as Fx;

beforeAll(async () => {
  await migrate();
  const A = (await signUp("qa-a")).id;
  const B = (await signUp("qa-b")).id;
  const C = (await signUp("qa-c")).id;
  Object.assign(fx, { A, B, C });
  fx.profileA = (await card.saveProfile(ctx(A), { ...baseProfile, name: "에이", offers: ["의료 AI"], needs: ["병원 유통"], fields: [{ type: "email", value: "a@qa.test", visibility: "business" }, { type: "other", label: "secret", value: `PRIVFIELD-${RUN}`, visibility: "private" }] })).id;
  fx.profileB = (await card.saveProfile(ctx(B), { ...baseProfile, name: "비", offers: ["병원 유통망"] })).id;
  await card.saveProfile(ctx(C), { ...baseProfile, name: "씨" });
  fx.contactA = (await relationship.createContact(ctx(A), { fullName: "김비밀", company: "비밀상사", email: "secret@corp.io", source: "manual", provenance: {} })).contactId;
  fx.contactA2 = (await relationship.createContact(ctx(A), { fullName: "박둘째", source: "manual", provenance: {} })).contactId;
  fx.contactB = (await relationship.createContact(ctx(B), { fullName: "B의연락처", source: "manual", provenance: {} })).contactId;
  await relationship.addNote(ctx(A), fx.contactA, `${PRIVATE} 이분은 이직 고민 중`);
  fx.meetingA = (await meeting.saveMeeting(ctx(A), { title: "A 미팅", participantContactIds: [fx.contactA], discussion: [], decisions: [], promises: [], actionItems: [] })).id;
  fx.followupA = (await meeting.createFollowup(ctx(A), { contactId: fx.contactA, kind: "custom", title: "A 후속" })).id;
  fx.sessionA = (await handoff.createExchangeSession(ctx(A), { capabilities: {}, group: false, context: {} })).sessionId;
  const i = await connection.createIntroduction(ctx(A), { partyAContactId: fx.contactA, partyBContactId: fx.contactA2, reason: "QA 소개" });
  fx.introA = i.id;
  await connection.recordIntroConsent(ctx(A), i.id, "a", true);
  fx.roomA = (await connection.recordIntroConsent(ctx(A), i.id, "b", true)).roomId!;
  fx.eventA = (await event.createEvent(ctx(A), { name: "QA Expo" })).id;
  fx.exportA = (await integration.createExport(ctx(A), { format: "csv", fields: ["fullName", "email"] })).id;
  fx.templateA = (await comms.saveTemplate(ctx(A), { name: "T", channel: "email", language: "ko", body: "안녕하세요 {{name}}님", scope: "user" })).id;
  fx.messageA = (await comms.createMessage(ctx(A), { contactId: fx.contactA, channel: "email", body: "초안", language: "ko", provenance: "user" })).id;
  fx.sequenceA = (await comms.createSequence(ctx(A), { contactId: fx.contactA, name: "seq", timezone: "Asia/Seoul", steps: [{ dayOffset: 1, kind: "check_in", channel: "email" }] })).id;
  fx.orgA = (await org.createOrg(ctx(A), { name: `QA Org ${RUN}` })).id;
  await grantSeats(fx.orgA);
  const inv = await org.createInvite(ctx(A), fx.orgA, { role: "member", maxUses: 5, ttlDays: 7 });
  fx.inviteA = inv.id;
  await org.acceptInvite(ctx(C), inv.token);
  await org.shareContacts(ctx(A), fx.orgA, { contactIds: [fx.contactA], asCompanyLead: false });
  fx.teamNoteA = (await org.addTeamNote(ctx(A), fx.orgA, fx.contactA, "팀 공유 메모")).id;
  const job = await capture.captureBusinessCard(ctx(A), { side: "front", kind: "card", engine: "qa", lines: [{ text: "김비밀" }, { text: "secret@corp.io" }] });
  fx.cardA = job.id;
  fx.accessReqA = (await card.requestAccess(ctx(B), fx.profileA, ["mobile"], "please")).id;
  await living.setActionCtas(ctx(A), fx.profileA, { booking: { enabled: false }, quote: { enabled: true }, proposal: { enabled: false }, nda: { enabled: false } });
  fx.actionReqA = (await living.submitActionRequest(ctx(null), fx.profileA, { kind: "quote", name: "게스트", email: "g@qa.test", details: {}, consent: true })).id;
  fx.notificationA = (await inbox.listNotifications(A))[0]?.id ?? null;
});

afterAll(async () => {
  await closePool();
});

// -------------------------------------------------------------------------------------------------------------------
/** `emptyOk`: a list endpoint scoped by owner may answer an empty list instead of 404 — that still leaks nothing. */
type Op = { name: string; run: (c: Ctx, id: string) => Promise<unknown>; target: () => string; emptyOk?: (out: unknown) => boolean };
const U = () => fx.A;

const OPS: Op[] = [
  // contacts / notes / encounters / merge
  { name: "relationship.getContactRow", target: () => fx.contactA, run: (c, id) => relationship.getContactRow(c.userId!, id) },
  { name: "relationship.contactTimeline", target: () => fx.contactA, run: (c, id) => relationship.contactTimeline(c.userId!, id) },
  { name: "relationship.updateContact", target: () => fx.contactA, run: (c, id) => relationship.updateContact(c, id, { fullName: "탈취" }) },
  { name: "relationship.deleteContact", target: () => fx.contactA, run: (c, id) => relationship.deleteContact(c, id) },
  { name: "relationship.addNote", target: () => fx.contactA, run: (c, id) => relationship.addNote(c, id, "x") },
  { name: "relationship.addEncounter", target: () => fx.contactA, run: (c, id) => relationship.addEncounter(c, id, { placeLabel: "x" }) },
  { name: "relationship.mergeContact(primary=foreign)", target: () => fx.contactA, run: (c, id) => relationship.mergeContact(c, id, c.userId === fx.B ? fx.contactB : fx.contactA2, {}) },
  { name: "relationship.mergeContact(secondary=foreign)", target: () => fx.contactA, run: (c, id) => relationship.mergeContact(c, c.userId === fx.B ? fx.contactB : fx.contactA2, id, {}) },
  { name: "relationship.undoMerge", target: () => fx.contactA, run: (c, id) => relationship.undoMerge(c, id) },
  { name: "network.strengthFor", target: () => fx.contactA, run: (c, id) => network.strengthFor(c, id) },
  { name: "assist.draftFollowup", target: () => fx.contactA, run: (c, id) => assist.draftFollowup(c, id) },
  { name: "comms.createAiDraft", target: () => fx.contactA, run: (c, id) => comms.createAiDraft(c, id, "thank_you") },
  { name: "comms.createMessage(contact=foreign)", target: () => fx.contactA, run: (c, id) => comms.createMessage(c, { contactId: id, channel: "email", body: "x", language: "ko", provenance: "user" }) },
  { name: "comms.createSequence(contact=foreign)", target: () => fx.contactA, run: (c, id) => comms.createSequence(c, { contactId: id, name: "s", timezone: "Asia/Seoul", steps: [{ dayOffset: 0, kind: "thank_you", channel: "email" }] }) },
  { name: "meeting.createFollowup(contact=foreign)", target: () => fx.contactA, run: (c, id) => meeting.createFollowup(c, { contactId: id, kind: "custom", title: "x" }) },
  { name: "meeting.saveMeeting(participant=foreign)", target: () => fx.contactA, run: (c, id) => meeting.saveMeeting(c, { title: "x", participantContactIds: [id], discussion: [], decisions: [], promises: [], actionItems: [] }) },
  { name: "connection.createIntroduction(foreign parties)", target: () => fx.contactA, run: (c, id) => connection.createIntroduction(c, { partyAContactId: id, partyBContactId: fx.contactA2, reason: "x" }) },
  { name: "files.contactCardImages", target: () => fx.contactA, run: (c, id) => files.contactCardImages(c, id), emptyOk: (o) => (o as { images: unknown[] }).images.length === 0 },
  // meetings / followups / recordings
  { name: "meeting.getMeeting", target: () => fx.meetingA, run: (c, id) => meeting.getMeeting(c.userId!, id) },
  { name: "meeting.saveMeeting(update)", target: () => fx.meetingA, run: (c, id) => meeting.saveMeeting(c, { title: "탈취", participantContactIds: [], discussion: [], decisions: [], promises: [], actionItems: [] }, id) },
  { name: "meeting.setRecordingConsent", target: () => fx.meetingA, run: (c, id) => meeting.setRecordingConsent(c, id, { ownerConsent: true, participantsAcknowledged: true, policy: "all_party" }) },
  { name: "meeting.createRecording", target: () => fx.meetingA, run: (c, id) => meeting.createRecording(c, id) },
  { name: "meeting.getMeetingBrief", target: () => fx.meetingA, run: (c, id) => meeting.getMeetingBrief(c, id) },
  { name: "recording.getTranscript", target: () => fx.meetingA, run: (c, id) => recording.getTranscript(c, id) },
  { name: "assist.extractMeeting", target: () => fx.meetingA, run: (c, id) => assist.extractMeeting(c, id, "결정: x") },
  { name: "meeting.completeFollowup", target: () => fx.followupA, run: (c, id) => meeting.completeFollowup(c, id, "done") },
  // exchange
  { name: "handoff.getSenderSessionStatus", target: () => fx.sessionA, run: (c, id) => handoff.getSenderSessionStatus(c, id) },
  { name: "handoff.revokeSession", target: () => fx.sessionA, run: (c, id) => handoff.revokeSession(c, id) },
  { name: "handoff.recordAttempt", target: () => fx.sessionA, run: (c, id) => handoff.recordAttempt(c, id, "qr", "failed") },
  // introductions / rooms
  { name: "connection.getIntroduction", target: () => fx.introA, run: (c, id) => connection.getIntroduction(c, id) },
  { name: "connection.recordIntroConsent", target: () => fx.introA, run: (c, id) => connection.recordIntroConsent(c, id, "a", false) },
  { name: "intro.draftIntroMessage", target: () => fx.introA, run: (c, id) => intro.draftIntroMessage(c, id) },
  { name: "intro.getIntroDraft", target: () => fx.introA, run: (c, id) => intro.getIntroDraft(c, id) },
  { name: "intro.setIntroOutcome", target: () => fx.introA, run: (c, id) => intro.setIntroOutcome(c, id, { outcome: "won" }) },
  { name: "connection.getConnectionRoom", target: () => fx.roomA, run: (c, id) => connection.getConnectionRoom(c, id) },
  { name: "connection.postRoomMessage", target: () => fx.roomA, run: (c, id) => connection.postRoomMessage(c, id, "침입") },
  { name: "connection.updateRoom", target: () => fx.roomA, run: (c, id) => connection.updateRoom(c, id, { status: "archived" }) },
  { name: "intro.summarizeRoom", target: () => fx.roomA, run: (c, id) => intro.summarizeRoom(c, id) },
  { name: "files.listRoomFiles", target: () => fx.roomA, run: (c, id) => files.listRoomFiles(c, id) },
  { name: "files.addRoomLink", target: () => fx.roomA, run: (c, id) => files.addRoomLink(c, id, { url: "https://example.com/x", title: "x" } as never) },
  // events
  { name: "event.getEvent", target: () => fx.eventA, run: (c, id) => event.getEvent(c, id) },
  { name: "event.eventMatches", target: () => fx.eventA, run: (c, id) => event.eventMatches(c, id) },
  // exports / files / cards
  { name: "integration.renderExport", target: () => fx.exportA, run: (c, id) => integration.renderExport(c, id) },
  { name: "files.listCardImages", target: () => fx.cardA, run: (c, id) => files.listCardImages(c, id) },
  { name: "files.deleteCardImage", target: () => fx.cardA, run: (c, id) => files.deleteCardImage(c, id, "front") },
  // comms
  { name: "comms.getMessage", target: () => fx.messageA, run: (c, id) => comms.getMessage(c.userId!, id) },
  { name: "comms.updateMessage", target: () => fx.messageA, run: (c, id) => comms.updateMessage(c, id, { body: "탈취" }) },
  { name: "comms.cancelMessage", target: () => fx.messageA, run: (c, id) => comms.cancelMessage(c, id) },
  { name: "comms.sendMessage", target: () => fx.messageA, run: (c, id) => comms.sendMessage(c, id, { via: "smtp" } as never) },
  { name: "comms.saveTemplate(update)", target: () => fx.templateA, run: (c, id) => comms.saveTemplate(c, { name: "x", channel: "email", language: "ko", body: "x", scope: "user" }, id) },
  { name: "comms.deleteTemplate", target: () => fx.templateA, run: (c, id) => comms.deleteTemplate(c, id) },
  { name: "comms.renderTemplateFor", target: () => fx.templateA, run: (c, id) => comms.renderTemplateFor(c, id, {}) },
  { name: "comms.cancelSequence", target: () => fx.sequenceA, run: (c, id) => comms.cancelSequence(c, id) },
  // profile / card
  { name: "card.saveProfile(update foreign)", target: () => fx.profileA, run: (c, id) => card.saveProfile(c, { ...baseProfile, name: "탈취" }, id) },
  { name: "living.setActionCtas", target: () => fx.profileA, run: (c, id) => living.setActionCtas(c, id, { booking: { enabled: false }, quote: { enabled: true }, proposal: { enabled: false }, nda: { enabled: false } }) },
  { name: "living.getOwnActionCtas", target: () => fx.profileA, run: (c, id) => living.getOwnActionCtas(c, id) },
  { name: "living.previewVariant", target: () => fx.profileA, run: (c, id) => living.previewVariant(c, id, {} as never) },
  { name: "card.resolveAccessRequest", target: () => fx.accessReqA, run: (c, id) => card.resolveAccessRequest(c, id, true) },
  { name: "living.updateActionRequest", target: () => fx.actionReqA, run: (c, id) => living.updateActionRequest(c, id, "done") },
  // org (B is not a member)
  { name: "org.getOrg", target: () => fx.orgA, run: (c, id) => org.getOrg(c, id) },
  { name: "org.updateOrg", target: () => fx.orgA, run: (c, id) => org.updateOrg(c, id, { name: "탈취" } as never) },
  { name: "org.deleteOrg", target: () => fx.orgA, run: (c, id) => org.deleteOrg(c, id) },
  { name: "org.addDomain", target: () => fx.orgA, run: (c, id) => org.addDomain(c, id, "qa.test") },
  { name: "org.listMembers", target: () => fx.orgA, run: (c, id) => org.listMembers(c, id) },
  { name: "org.listInvites", target: () => fx.orgA, run: (c, id) => org.listInvites(c, id) },
  { name: "org.createInvite", target: () => fx.orgA, run: (c, id) => org.createInvite(c, id, { role: "admin", maxUses: 1, ttlDays: 1 }) },
  { name: "org.changeRole(self→owner)", target: () => fx.orgA, run: (c, id) => org.changeRole(c, id, c.userId ?? fx.B, "owner") },
  { name: "org.listTeamContacts", target: () => fx.orgA, run: (c, id) => org.listTeamContacts(c, id) },
  { name: "org.getTeamContact", target: () => fx.orgA, run: (c, id) => org.getTeamContact(c, id, fx.contactA) },
  { name: "org.listTeamNotes", target: () => fx.orgA, run: (c, id) => org.listTeamNotes(c, id, fx.contactA) },
  { name: "org.addTeamNote", target: () => fx.orgA, run: (c, id) => org.addTeamNote(c, id, fx.contactA, "침입") },
  { name: "org.shareContacts(own into foreign org)", target: () => fx.orgA, run: (c, id) => org.shareContacts(c, id, { contactIds: [c.userId === fx.B ? fx.contactB : fx.contactA2], asCompanyLead: false }) },
  { name: "org.createLead", target: () => fx.orgA, run: (c, id) => org.createLead(c, id, { fullName: "x", source: "manual", provenance: {} } as never) },
  { name: "org.setActiveOrg", target: () => fx.orgA, run: (c, id) => org.setActiveOrg(c, id) },
  { name: "network.whoKnows", target: () => fx.orgA, run: (c, id) => network.whoKnows(c, id, "비밀") },
  { name: "network.orgGraph", target: () => fx.orgA, run: (c, id) => network.orgGraph(c, id) },
  { name: "org.deleteTeamNote", target: () => fx.teamNoteA, run: (c, id) => org.deleteTeamNote(c, fx.orgA, id) },
  { name: "org.revokeInvite", target: () => fx.inviteA, run: (c, id) => org.revokeInvite(c, fx.orgA, id) },
];

function isClientError(e: unknown): e is InstanceType<typeof ApiError> {
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
}

async function expect4xx(p: () => Promise<unknown>, label: string, emptyOk?: (out: unknown) => boolean) {
  let out: unknown;
  try {
    out = await p();
  } catch (e) {
    if (isClientError(e)) return e.status;
    throw new Error(`${label}: expected a 4xx ApiError, got ${(e as Error)?.name}: ${(e as Error)?.message} (route layer → 500)`);
  }
  if (emptyOk?.(out)) return 200;
  throw new Error(`${label}: expected rejection, but it succeeded → ${JSON.stringify(out)?.slice(0, 200)}`);
}

const VARIANTS = [
  { v: "cross-tenant (user B)", actor: () => fx.B, id: (op: Op) => op.target() },
  { v: "anonymous", actor: () => null, id: (op: Op) => op.target() },
  { v: "malformed id", actor: U, id: () => "not-a-uuid'--" },
  { v: "unknown uuid", actor: U, id: () => randomUUID() },
] as const;

describe(`QA API · authz & id hygiene (${OPS.length} ops × ${VARIANTS.length} variants)`, () => {
  const table = OPS.flatMap((op) => VARIANTS.map((variant) => ({ op, variant, label: `${op.name} · ${variant.v}` })));
  it.each(table)("$label", async ({ op, variant, label }) => {
    await expect4xx(() => op.run(ctx(variant.actor()), variant.id(op)), label, variant.v === "malformed id" ? undefined : op.emptyOk);
  });

  it("A's data is untouched after every foreign attempt", async () => {
    const c = await relationship.getContactRow(fx.A, fx.contactA);
    expect(c.fullName).toBe("김비밀");
    expect((await meeting.getMeeting(fx.A, fx.meetingA)).title).toBe("A 미팅");
    expect((await org.getOrg(ctx(fx.A), fx.orgA)).name).toBe(`QA Org ${RUN}`);
    const room = await connection.getConnectionRoom(ctx(fx.A), fx.roomA);
    expect(JSON.stringify(room)).not.toContain("침입");
    expect((await handoff.getSenderSessionStatus(ctx(fx.A), fx.sessionA)).state).not.toBe("REVOKED");
    expect((await comms.getMessage(fx.A, fx.messageA)).body).toBe("초안");
    const roles = await q<{ role: string; user_id: string }>("SELECT role, user_id FROM organization_members WHERE organization_id=$1", [fx.orgA]);
    expect(roles.find((r) => r.user_id === fx.B)).toBeUndefined();
    expect(roles.find((r) => r.user_id === fx.C)?.role).toBe("member");
  });
});

// member C inside A's org: RBAC on org admin operations
const MEMBER_DENIED: { name: string; run: (c: Ctx) => Promise<unknown> }[] = [
  { name: "updateOrg", run: (c) => org.updateOrg(c, fx.orgA, { name: "x" } as never) },
  { name: "deleteOrg", run: (c) => org.deleteOrg(c, fx.orgA) },
  { name: "addDomain", run: (c) => org.addDomain(c, fx.orgA, "qa.test") },
  { name: "changeRole(self→admin)", run: (c) => org.changeRole(c, fx.orgA, fx.C, "admin") },
  { name: "changeRole(owner→member)", run: (c) => org.changeRole(c, fx.orgA, fx.A, "member") },
  { name: "removeMember(owner)", run: (c) => org.removeMember(c, fx.orgA, fx.A, null) },
  { name: "createInvite", run: (c) => org.createInvite(c, fx.orgA, { role: "member", maxUses: 1, ttlDays: 1 }) },
  { name: "listInvites", run: (c) => org.listInvites(c, fx.orgA) },
  { name: "revokeInvite", run: (c) => org.revokeInvite(c, fx.orgA, fx.inviteA) },
  { name: "deleteTeamNote(of A)", run: (c) => org.deleteTeamNote(c, fx.orgA, fx.teamNoteA) },
  { name: "assignLead", run: (c) => org.assignLead(c, fx.orgA, fx.contactA, fx.C) },
  { name: "unshareContact(of A)", run: (c) => org.unshareContact(c, fx.orgA, fx.contactA) },
  { name: "shareContacts(A's contact)", run: (c) => org.shareContacts(c, fx.orgA, { contactIds: [fx.contactA2], asCompanyLead: false }) },
  { name: "relationship.getContactRow(shared)", run: (c) => relationship.getContactRow(c.userId!, fx.contactA) },
  { name: "relationship.updateContact(shared)", run: (c) => relationship.updateContact(c, fx.contactA, { fullName: "x" }) },
];

describe(`QA API · org member RBAC (${MEMBER_DENIED.length} admin operations)`, () => {
  it.each(MEMBER_DENIED)("member C cannot $name", async ({ name, run }) => {
    await expect4xx(() => run(ctx(fx.C)), name);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe("QA API · private notes never leak", () => {
  const PATHS: { name: string; run: () => Promise<unknown> }[] = [
    { name: "team: listTeamContacts (C)", run: () => org.listTeamContacts(ctx(fx.C), fx.orgA) },
    { name: "team: getTeamContact (C)", run: () => org.getTeamContact(ctx(fx.C), fx.orgA, fx.contactA) },
    { name: "team: listTeamNotes (C)", run: () => org.listTeamNotes(ctx(fx.C), fx.orgA, fx.contactA) },
    { name: "team: whoKnows (C)", run: () => network.whoKnows(ctx(fx.C), fx.orgA, "비밀") },
    { name: "team: orgGraph (C)", run: () => network.orgGraph(ctx(fx.C), fx.orgA) },
    { name: "team: listTeamNotes (A, owner view)", run: () => org.listTeamNotes(ctx(fx.A), fx.orgA, fx.contactA) },
    { name: "export: exportMyData (C)", run: () => security.exportMyData(ctx(fx.C)) },
    { name: "export: exportMyData (B)", run: () => security.exportMyData(ctx(fx.B)) },
    { name: "export: renderExport csv (A, contacts export)", run: async () => (await integration.renderExport(ctx(fx.A), fx.exportA)).body },
    { name: "search: relationshipSearch (B)", run: async () => (await ai.relationshipSearch(ctx(fx.B), PRIVATE)).results },
    { name: "search: relationshipSearch (C)", run: async () => (await ai.relationshipSearch(ctx(fx.C), PRIVATE)).results },
    { name: "search: relationshipSearch (C, by contact name)", run: async () => (await ai.relationshipSearch(ctx(fx.C), "김비밀 이직")).results },
    { name: "AI: listMatches (B)", run: () => ai.listMatches(ctx(fx.B)) },
    { name: "AI: draftFollowup (A → contact, would be emailed to them)", run: () => assist.draftFollowup(ctx(fx.A), fx.contactA) },
    { name: "AI: createAiDraft (A → contact)", run: () => comms.createAiDraft(ctx(fx.A), fx.contactA, "check_in") },
    { name: "intro: draftIntroMessage (sent to both parties)", run: () => intro.draftIntroMessage(ctx(fx.A), fx.introA) },
    { name: "room: getConnectionRoom (shared with parties)", run: () => connection.getConnectionRoom(ctx(fx.A), fx.roomA) },
    { name: "public card: getPublicProfileBySlug (B)", run: async () => card.getPublicProfileBySlug((await card.loadProfile(fx.profileA))!.slug, fx.B) },
    { name: "public card: exchange card (guest)", run: () => card.getExchangeCard(fx.profileA) },
    { name: "guest landing: openGuestLanding", run: async () => handoff.openGuestLanding((await handoff.createExchangeSession(ctx(fx.A), { capabilities: {}, group: false, context: {} })).token, ctx(null), "anon") },
    { name: "notifications (B)", run: () => inbox.listNotifications(fx.B) },
    { name: "outbox/audit payloads", run: () => q("SELECT payload FROM outbox_events UNION ALL SELECT metadata FROM audit_logs") },
  ];
  it.each(PATHS)("$name", async ({ run }) => {
    const out = JSON.stringify(await run());
    expect(out).not.toContain(PRIVATE);
    expect(out).not.toContain(`PRIVFIELD-${RUN}`); // private profile field
  });
  it("…while the owner still sees the note on their own timeline", async () => {
    expect(JSON.stringify(await relationship.contactTimeline(fx.A, fx.contactA))).toContain(PRIVATE);
  });
});

// -------------------------------------------------------------------------------------------------------------------
type Bad = [string, unknown];
const SCHEMAS: { name: string; schema: ZodType; ok: unknown; bad: Bad[] }[] = [
  {
    name: "contactInput", schema: relationship.contactInput, ok: { fullName: "김민수" },
    bad: [["empty name", { fullName: "" }], ["blank name", { fullName: "   " }], ["long name", { fullName: "x".repeat(121) }], ["missing name", {}], ["bad source", { fullName: "a", source: "hack" }], ["confidence > 1", { fullName: "a", provenance: { email: { source: "ocr", confidence: 1.5 } } }], ["21 tags", { fullName: "a", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }], ["empty tag", { fullName: "a", tags: [" "] }], ["bad card id", { fullName: "a", businessCardId: "x" }], ["bad occurredAt", { fullName: "a", encounter: { occurredAt: "yesterday" } }], ["name as number", { fullName: 42 }], ["long phone", { fullName: "a", phone: "1".repeat(61) }]],
  },
  {
    name: "meetingInput", schema: meeting.meetingInput, ok: { title: "m" },
    bad: [["no title", {}], ["empty title", { title: " " }], ["bad startedAt", { title: "m", startedAt: "2026-13-01" }], ["bad participant", { title: "m", participantContactIds: ["x"] }], ["51 participants", { title: "m", participantContactIds: Array.from({ length: 51 }, () => randomUUID()) }], ["bad promise by", { title: "m", promises: [{ text: "x", by: "him" }] }], ["bad action status", { title: "m", actionItems: [{ description: "x", status: "maybe" }] }]],
  },
  {
    name: "followupInput", schema: meeting.followupInput, ok: { title: "f" },
    bad: [["no title", {}], ["bad kind", { title: "f", kind: "spam" }], ["bad due", { title: "f", dueAt: "soon" }], ["bad contact", { title: "f", contactId: "1" }], ["long body", { title: "f", bodyDraft: "x".repeat(4001) }]],
  },
  {
    name: "eventInput", schema: event.eventInput, ok: { name: "e" },
    bad: [["no name", {}], ["long name", { name: "x".repeat(201) }], ["bad start", { name: "e", startsAt: "tomorrow" }]],
  },
  {
    name: "introInput", schema: connection.introInput, ok: { partyAContactId: randomUUID(), partyBContactId: randomUUID(), reason: "r" },
    bad: [["no reason", { partyAContactId: randomUUID(), partyBContactId: randomUUID() }], ["bad id", { partyAContactId: "a", partyBContactId: randomUUID(), reason: "r" }], ["long reason", { partyAContactId: randomUUID(), partyBContactId: randomUUID(), reason: "x".repeat(1001) }]],
  },
  {
    name: "exportInput", schema: integration.exportInput, ok: { format: "csv" },
    bad: [["bad format", { format: "exe" }], ["no fields", { format: "csv", fields: [] }], ["unknown field", { format: "csv", fields: ["password"] }], ["notes field", { format: "csv", fields: ["notes"] }]],
  },
  {
    name: "templateInput", schema: comms.templateInput, ok: { name: "t", body: "b" },
    bad: [["no body", { name: "t" }], ["bad channel", { name: "t", body: "b", channel: "fax" }], ["bad scope", { name: "t", body: "b", scope: "global" }], ["bad org id", { name: "t", body: "b", organizationId: "x" }], ["long body", { name: "t", body: "x".repeat(5001) }]],
  },
  {
    name: "messageInput", schema: comms.messageInput, ok: { body: "b" },
    bad: [["no body", {}], ["blank body", { body: "  " }], ["bad provenance", { body: "b", provenance: "fabricated" }], ["bad channel", { body: "b", channel: "pigeon" }]],
  },
  {
    name: "sequenceInput", schema: comms.sequenceInput, ok: { contactId: randomUUID() },
    bad: [["no contact", {}], ["bad tz", { contactId: randomUUID(), timezone: "Mars/Base" }], ["no steps", { contactId: randomUUID(), steps: [] }], ["7 steps", { contactId: randomUUID(), steps: Array.from({ length: 7 }, () => ({ dayOffset: 1, kind: "check_in", channel: "email" })) }], ["negative offset", { contactId: randomUUID(), steps: [{ dayOffset: -1, kind: "check_in", channel: "email" }] }]],
  },
  {
    name: "createSessionInput", schema: handoff.createSessionInput, ok: {},
    bad: [["maxUses 0", { group: true, maxUses: 0 }], ["capabilities string", { capabilities: "all" }]],
  },
  {
    name: "replyInput", schema: handoff.replyInput, ok: { card: { fullName: "g" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} },
    bad: [["no consent", { card: { fullName: "g" }, sharedFields: ["fullName"], provenance: {} }], ["consent false", { card: { fullName: "g" }, sharedFields: ["fullName"], consent: { exchange: false }, provenance: {} }], ["no name", { card: {}, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} }], ["unknown shared field", { card: { fullName: "g" }, sharedFields: ["password"], consent: { exchange: true }, provenance: {} }]],
  },
  {
    name: "orgCreateInput", schema: org.orgCreateInput, ok: { name: "Org" },
    bad: [["short", { name: "a" }], ["long", { name: "x".repeat(81) }], ["missing", {}]],
  },
  {
    name: "inviteInput", schema: org.inviteInput, ok: {},
    bad: [["bad role", { role: "god" }], ["0 uses", { maxUses: 0 }], ["31 days", { ttlDays: 31 }]],
  },
  {
    name: "shareInput", schema: org.shareInput, ok: { contactIds: [randomUUID()] },
    bad: [["empty", { contactIds: [] }], ["bad id", { contactIds: ["x"] }], ["501", { contactIds: Array.from({ length: 501 }, () => randomUUID()) }]],
  },
  {
    name: "profileInput", schema: card.profileInput, ok: { name: "n" },
    bad: [["no name", {}], ["4 keywords", { name: "n", keywords: ["a", "b", "c", "d"] }], ["bad visibility", { name: "n", fields: [{ type: "email", value: "a@b.io", visibility: "everyone" }] }], ["bad theme", { name: "n", theme: "neon" }], ["11 offers", { name: "n", offers: Array.from({ length: 11 }, (_, i) => `o${i}`) }], ["empty field value", { name: "n", fields: [{ type: "email", value: " " }] }]],
  },
  {
    name: "actionRequestInput", schema: living.actionRequestInput, ok: { kind: "quote", name: "n", email: "a@b.io", consent: true },
    bad: [["no consent", { kind: "quote", name: "n", email: "a@b.io" }], ["consent false", { kind: "quote", name: "n", email: "a@b.io", consent: false }], ["honeypot filled", { kind: "quote", name: "n", email: "a@b.io", consent: true, website: "http://spam" }], ["bad kind", { kind: "loan", name: "n", email: "a@b.io", consent: true }]],
  },
  {
    name: "actionCtasInput", schema: living.actionCtasInput, ok: {},
    bad: [["http booking", { booking: { enabled: true, url: "http://x.io" } }], ["javascript booking", { booking: { enabled: true, url: "javascript:alert(1)" } }]],
  },
];

describe(`QA API · request validation (${SCHEMAS.length} schemas)`, () => {
  it.each(SCHEMAS.map((s) => ({ name: s.name, schema: s.schema, ok: s.ok })))("$name accepts a minimal valid body", ({ schema, ok }) => {
    expect(schema.safeParse(ok).success).toBe(true);
  });
  it.each(SCHEMAS.flatMap((s) => s.bad.map(([why, body]) => ({ label: `${s.name}: ${why}`, schema: s.schema, body }))))("$label → 400 validation_failed", ({ schema, body }) => {
    expect(schema.safeParse(body).success).toBe(false);
  });
});

describe("QA API · service-level validation", () => {
  it.each([
    ["same party intro", () => connection.createIntroduction(ctx(fx.A), { partyAContactId: fx.contactA, partyBContactId: fx.contactA, reason: "x" }), 400],
    ["merge with itself", () => relationship.mergeContact(ctx(fx.A), fx.contactA, fx.contactA, {}), 400],
    ["invalid OTP email", () => identity.requestOtp(ctx(null), "not-an-email"), 400],
    ["OTP wrong code", async () => {
      await identity.requestOtp(ctx(null), `wrong-${RUN}@qa.test`);
      return identity.verifyOtp(ctx(null), `wrong-${RUN}@qa.test`, "abcdef", consents);
    }, 400],
    ["signup without consents", async () => {
      const e = `nocons-${RUN}@qa.test`;
      const { devCode } = await identity.requestOtp(ctx(null), e);
      return identity.verifyOtp(ctx(null), e, devCode!, []);
    }, 400],
    ["recording without consent", () => meeting.createRecording(ctx(fx.A), fx.meetingA), 409],
    ["reply to revoked session", async () => {
      const s = await handoff.createExchangeSession(ctx(fx.A), { capabilities: {}, group: false, context: {} });
      await handoff.revokeSession(ctx(fx.A), s.sessionId);
      return handoff.replyExchange(s.token, ctx(null), { card: { fullName: "g" }, sharedFields: ["fullName"], consent: { exchange: true }, provenance: {} });
    }, 410],
    ["guest landing with garbage token", () => handoff.openGuestLanding("../../etc/passwd", ctx(null), "a"), 404],
    ["guest landing with SQL-ish short code", () => handoff.openGuestLanding("' OR 1=1 --", ctx(null), "a"), 404],
    ["claim with unknown token", () => handoff.claimGuest(ctx(fx.B), "A".repeat(32)), 404],
    ["accept unknown invite", () => org.acceptInvite(ctx(fx.B), "B".repeat(32)), 404],
    ["webhook to private address", () => api.webhooks.createEndpoint(ctx(fx.A), { url: "https://[::ffff:127.0.0.1]/hook", events: ["contact.updated"] } as never), 400],
    ["webhook to localhost.", () => api.webhooks.createEndpoint(ctx(fx.A), { url: "https://localhost./hook", events: ["contact.updated"] } as never), 400],
  ] as const)("%s → %i", async (label, run, status) => {
    let err: unknown;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    expect(err, `${label} should fail`).toBeDefined();
    expect(isClientError(err), `${label}: ${(err as Error)?.message}`).toBe(true);
    expect([status, 400, 404, 409, 410, 403, 422, 401]).toContain((err as InstanceType<typeof ApiError>).status);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe("QA API · idempotency replays", () => {
  it.each(Array.from({ length: 8 }, (_, i) => i))("replay #%i returns the stored response without re-running", async (i) => {
    const key = `qa-${RUN}-${i}`;
    const body = { fullName: `멱등-${i}`, n: i };
    let runs = 0;
    const exec = async () => {
      runs++;
      const r = await relationship.createContact(ctx(fx.B), { fullName: body.fullName, source: "manual", provenance: {} });
      return { status: 201, body: { id: r.contactId } };
    };
    const first = await withIdempotency(`qa:${fx.B}`, key, body, exec);
    const again = await withIdempotency(`qa:${fx.B}`, key, { ...body }, exec);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(again.status).toBe(201);
    expect(runs).toBe(1);
    const rows = await q("SELECT 1 FROM contacts WHERE owner_user_id=$1 AND full_name=$2", [fx.B, body.fullName]);
    expect(rows).toHaveLength(1);
    await expect(withIdempotency(`qa:${fx.B}`, key, { ...body, fullName: "다른 요청" }, exec)).rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
    // the same key in another user's scope is a different request
    const other = await withIdempotency(`qa:${fx.C}`, key, body, async () => ({ status: 200, body: { id: "c" } }));
    expect(other.replayed).toBe(false);
  });
});
