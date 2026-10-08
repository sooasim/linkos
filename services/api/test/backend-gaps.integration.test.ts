// Whitepaper gap closure, backend round 2 — acceptance paths against Postgres:
// §3.1 exchange state machine (DISCOVERING / CONSENT_PENDING / SYNCED) · §20 guest SSE propagation · F-161 guest consent
// ledger · §9 Encounter append-only guard · F-139 CRM-sync policy on share/lead paths · F-092 match privacy_penalty from
// field ACL · F-096/F-089 brief history · F-166 bulk-read + storage purge audit · exportMyData queued job · F-191 seats.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeGoogle, startFakeGoogle } from "./fakeGoogle";
import { grantSeats } from "./seats";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_bg";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 31).toString("base64");
delete process.env.CREDENTIALS_KEYS;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { allowEncounterRewrite } = await import("../src/lib/db");
const { ai, card, enterprise, files, handoff, identity, integration, meeting, org, relationship, security, q, one, tx, closePool } = api;

const ctx = (userId: string | null, ip = "10.7.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const stamp = Date.now();
let n = 0;
async function user(prefix = "u", domain = "bg.test") {
  const email = `${prefix}${stamp}-${n++}@${domain}`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}
const baseProfile = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
async function withCard(prefix: string, name = prefix) {
  const u = await user(prefix);
  await card.saveProfile(ctx(u.id), { ...baseProfile, name });
  return u;
}
async function drain() {
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
}
const guestReply = (fullName = "게스트") => ({
  card: { fullName, company: "게스트상사", email: "guest@example.com" },
  sharedFields: ["fullName", "company", "email"] as ("fullName" | "company" | "email")[],
  consent: { exchange: true as const, policyVersion: "2026-10-01" },
  provenance: {},
});
async function history(sessionId: string) {
  return (await one<{ h: { from: string | null; to: string }[] }>("SELECT state_history AS h FROM exchange_sessions WHERE id=$1", [sessionId]))!.h.map((x) => x.to);
}
async function connectGoogle(userId: string) {
  const { tok } = await integration.exchangeGoogleCode("code-abc");
  await integration.storeGoogleAccount(userId, tok);
}

let g: FakeGoogle;
beforeAll(async () => {
  g = await startFakeGoogle();
  process.env.GOOGLE_API_BASE = g.url;
  await migrate();
});
afterAll(async () => {
  await drain();
  await g.close();
  await closePool();
});

describe("§3.1 exchange state machine (F-037~F-064)", () => {
  it("creation walks CREATED → DISCOVERING → CHANNEL_SELECTED; review → CONSENT_PENDING; reply → EXCHANGED → CLAIM_PENDING", async () => {
    const sender = await withCard("sm-sender", "상태머신");
    const s = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({ capabilities: { webShare: true } }));
    expect(s.state).toBe("CHANNEL_SELECTED"); // response contract unchanged
    expect(await history(s.sessionId)).toEqual(["CREATED", "DISCOVERING", "CHANNEL_SELECTED"]);

    const landing = await handoff.openGuestLanding(s.token, ctx(null), "anon-sm");
    expect(landing.state).toBe("RECEIVER_OPENED");
    const reviewed = await handoff.reviewExchange(s.token, ctx(null));
    expect(reviewed).toMatchObject({ state: "CONSENT_PENDING", acceptsReply: true });
    expect(await handoff.reviewExchange(s.token, ctx(null))).toMatchObject({ state: "CONSENT_PENDING" }); // idempotent
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), s.sessionId)).state).toBe("CONSENT_PENDING");
    // no draft data is stored for the review step (data minimization)
    expect(await one("SELECT 1 FROM guest_claims WHERE exchange_session_id=$1", [s.sessionId])).toBeNull();

    const r = await handoff.replyExchange(s.token, ctx(null), handoff.replyInput.parse(guestReply()));
    expect(r.claimToken).toBeTruthy();
    expect((await handoff.getGuestSessionStatus(s.token, ctx(null))).state).toBe("CLAIM_PENDING");
    expect(await history(s.sessionId)).toEqual(["CREATED", "DISCOVERING", "CHANNEL_SELECTED", "RECEIVER_OPENED", "CONSENT_PENDING", "EXCHANGED", "CLAIM_PENDING"]);
    await expect(handoff.reviewExchange(s.token, ctx(null))).rejects.toMatchObject({ status: 409, code: "already_exchanged" });
  });

  it("a reply without the landing/review GETs still passes RECEIVER_OPENED and CONSENT_PENDING; group sessions reopen for the next guest", async () => {
    const sender = await withCard("sm-group");
    const grp = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({ group: true, maxUses: 2 }));
    await handoff.replyExchange(grp.token, ctx(null, "10.7.0.2"), handoff.replyInput.parse(guestReply("첫째")));
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), grp.sessionId)).state).toBe("RECEIVER_OPENED");
    expect(await history(grp.sessionId)).toEqual(["CREATED", "DISCOVERING", "CHANNEL_SELECTED", "RECEIVER_OPENED", "CONSENT_PENDING", "RECEIVER_OPENED"]);
    await handoff.replyExchange(grp.token, ctx(null, "10.7.0.3"), handoff.replyInput.parse(guestReply("둘째")));
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), grp.sessionId)).state).toBe("CLAIM_PENDING");
  });

  it("SYNCED: Google sync of the exchange contact → EXCHANGED→SYNCED (signed-in receiver), CLAIM_PENDING defers until CLAIMED", async () => {
    const sender = await withCard("sm-sync", "동기화보낸이");
    await connectGoogle(sender.id);

    // signed-in receiver: EXCHANGED → SYNCED as soon as the sender's new contact reached Google
    const receiver = await withCard("sm-recv", "받는이");
    const s1 = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    await handoff.replyExchange(s1.token, ctx(receiver.id), handoff.replyInput.parse(guestReply("받는이")));
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), s1.sessionId)).state).toBe("EXCHANGED");
    await drain();
    await integration.processSyncJobs();
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), s1.sessionId)).state).toBe("SYNCED");
    expect((await history(s1.sessionId)).slice(-2)).toEqual(["EXCHANGED", "SYNCED"]);

    // guest: CLAIM_PENDING cannot skip CLAIMED → the sync is remembered and applied right after the claim
    const s2 = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    const r2 = await handoff.replyExchange(s2.token, ctx(null, "10.7.0.4"), handoff.replyInput.parse(guestReply("나중가입")));
    await drain();
    await integration.processSyncJobs();
    const row = await one<{ state: string; synced_at: Date | null }>("SELECT state, synced_at FROM exchange_sessions WHERE id=$1", [s2.sessionId]);
    expect(row).toMatchObject({ state: "CLAIM_PENDING" });
    expect(row!.synced_at).toBeTruthy();
    const claimant = await user("sm-claim");
    await handoff.claimGuest(ctx(claimant.id), r2.claimToken!);
    expect((await history(s2.sessionId)).slice(-3)).toEqual(["CLAIM_PENDING", "CLAIMED", "SYNCED"]);

    // a session that is not exchanged yet is never marked
    const s3 = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    expect(await handoff.markExchangeSynced((await relationship.createContact(ctx(sender.id), { fullName: "무관", source: "manual", provenance: {} })).contactId)).toEqual({ synced: 0, deferred: 0 });
    expect((await handoff.getSenderSessionStatus(ctx(sender.id), s3.sessionId)).state).toBe("CHANNEL_SELECTED");
  });
});

describe("F-053 §20 guest SSE propagation (< 1s)", () => {
  it("polls by primary key at ≤ 1s and keeps following a 4-digit code after it is released", async () => {
    expect(handoff.GUEST_SSE_POLL_MS).toBeLessThanOrEqual(1000);
    const route = readFileSync(resolve(__dirname, "../../../apps/web/src/app/api/v1/exchange/sessions/[token]/events/route.ts"), "utf8");
    expect(route).toContain("handoff.GUEST_SSE_POLL_MS");
    expect(route).not.toMatch(/setTimeout\(r, 3000\)/);

    const sender = await withCard("sse");
    const s = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({ capabilities: { online: true } }));
    expect(s.shortCode).toMatch(/^\d{4}$/);
    const stream = await handoff.openGuestStatusStream(s.shortCode!, ctx(null, "10.7.1.1"));
    expect(stream.first).toMatchObject({ state: "CHANNEL_SELECTED", acceptsReply: true });
    await handoff.replyExchange(s.token, ctx(null, "10.7.1.1"), handoff.replyInput.parse(guestReply()));
    // the code is released on completion, but the open stream still sees the change on its next (cheap) poll
    expect(await one("SELECT 1 FROM exchange_sessions WHERE short_code=$1 AND id=$2", [s.shortCode, s.sessionId])).toBeNull();
    const t0 = Date.now();
    expect(await stream.poll()).toMatchObject({ state: "CLAIM_PENDING", acceptsReply: false });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("F-161 consent ledger — guest exchange consent at reply time", () => {
  it("records the guest's consent on reply (field names only) and links it to the account on claim without duplicating", async () => {
    const sender = await withCard("consent-s");
    const s = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    const r = await handoff.replyExchange(s.token, ctx(null, "10.7.2.1"), handoff.replyInput.parse(guestReply("동의게스트")));
    const claim = await one<{ id: string }>("SELECT id FROM guest_claims WHERE exchange_session_id=$1", [s.sessionId]);
    const rows = await q<{ subject_user_id: string | null; consent_type: string; policy_version: string; granted: boolean; context: any; exchange_session_id: string }>(
      "SELECT subject_user_id, consent_type, policy_version, granted, context, exchange_session_id FROM consent_records WHERE guest_claim_id=$1",
      [claim!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_user_id: null, consent_type: "exchange", granted: true, exchange_session_id: s.sessionId, context: { fields: ["fullName", "company", "email"], guest: true } });
    expect(rows[0]!.policy_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(rows[0])).not.toContain("guest@example.com"); // values never enter the ledger

    const claimant = await user("consent-c");
    await handoff.claimGuest(ctx(claimant.id), r.claimToken!);
    const after = await q<{ subject_user_id: string }>("SELECT subject_user_id FROM consent_records WHERE guest_claim_id=$1", [claim!.id]);
    expect(after).toEqual([{ subject_user_id: claimant.id }]);
    expect((await identity.currentConsents(claimant.id)).find((c) => c.consent_type === "exchange")).toBeTruthy();
    // signed-in receivers are linked to the session as well
    const recv = await withCard("consent-r");
    const s2 = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    await handoff.replyExchange(s2.token, ctx(recv.id), handoff.replyInput.parse(guestReply("로그인수신")));
    expect(await one("SELECT 1 FROM consent_records WHERE subject_user_id=$1 AND exchange_session_id=$2 AND consent_type='exchange'", [recv.id, s2.sessionId])).toBeTruthy();
  });
});

describe("F-067 §9 Encounter append-only (DB guard) · F-167 deletion path", () => {
  it("refuses content updates and plain deletes; allows owner reassignment, merges and privacy deletion", async () => {
    const u = await user("enc");
    const a = await relationship.createContact(ctx(u.id), relationship.contactInput.parse({ fullName: "만남기록", encounter: { placeLabel: "코엑스", note: "첫 만남" } }));
    const enc = await one<{ id: string }>("SELECT id FROM encounters WHERE contact_id=$1", [a.contactId]);
    for (const sql of [
      "UPDATE encounters SET note='고쳐쓰기' WHERE id=$1",
      "UPDATE encounters SET occurred_at=now() - interval '1 year' WHERE id=$1",
      "UPDATE encounters SET place_label='다른곳' WHERE id=$1",
      "UPDATE encounters SET source='exchange' WHERE id=$1",
      "UPDATE encounters SET event_id=gen_random_uuid() WHERE id=$1",
    ]) {
      await expect(q(sql, [enc!.id]), sql).rejects.toThrow(/append-only/);
    }
    await expect(q("DELETE FROM encounters WHERE id=$1", [enc!.id])).rejects.toThrow(/append-only/);
    const b = await relationship.createContact(ctx(u.id), relationship.contactInput.parse({ fullName: "다른사람" }));
    await expect(q("UPDATE encounters SET contact_id=$2 WHERE id=$1", [enc!.id, b.contactId])).rejects.toThrow(/append-only/);
    expect(await one<{ note: string }>("SELECT note FROM encounters WHERE id=$1", [enc!.id])).toMatchObject({ note: "첫 만남" });

    // ownership transfer (F-132 lead reassignment) only moves owner_user_id — allowed
    const other = await user("enc-owner");
    await q("UPDATE encounters SET owner_user_id=$2 WHERE id=$1", [enc!.id, other.id]);
    await q("UPDATE encounters SET owner_user_id=$2 WHERE id=$1", [enc!.id, u.id]);
    // the opt-in is transaction-local: it does not leak to the next statement on a pooled connection
    await tx(async (c) => {
      await allowEncounterRewrite(c, "relink");
      await c.query("SELECT 1");
    });
    await expect(q("UPDATE encounters SET contact_id=$2 WHERE id=$1", [enc!.id, b.contactId])).rejects.toThrow(/append-only/);

    // duplicate merge re-points encounters to the survivor (sanctioned relink)
    await relationship.mergeContact(ctx(u.id), b.contactId, a.contactId, {});
    expect(await one<{ contact_id: string; note: string }>("SELECT contact_id, note FROM encounters WHERE id=$1", [enc!.id])).toMatchObject({ contact_id: b.contactId, note: "첫 만남" });

    // privacy deletion (worker) removes the account and its encounters
    await security.requestDeletion(ctx(u.id));
    await q("UPDATE deletion_requests SET deadline = now() - interval '1 minute' WHERE user_id=$1", [u.id]);
    await security.processDeletions();
    expect(await one("SELECT 1 FROM encounters WHERE id=$1", [enc!.id])).toBeNull();
  });
});

describe("F-139 CRM sync required — share-to-org and lead capture", () => {
  it("422 without an allowed CRM; queues the CRM push once connected (share as company lead, createLead, convert)", async () => {
    const owner = await user("crm-own");
    const member = await user("crm-mem");
    const orgId = (await org.createOrg(ctx(owner.id), { name: `CRM 정책 ${stamp}` })).id;
    await grantSeats(orgId);
    const inv = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "member" }));
    await org.acceptInvite(ctx(member.id), inv.token);
    await enterprise.updatePolicies(ctx(owner.id), orgId, enterprise.policiesInput.parse({ requireCrmSync: true, crmSyncProviders: ["hubspot"] }));

    const mine = await relationship.createContact(ctx(owner.id), relationship.contactInput.parse({ fullName: "공유대상", company: "에이" }));
    await expect(org.shareContacts(ctx(owner.id), orgId, { contactIds: [mine.contactId], asCompanyLead: true })).rejects.toMatchObject({ status: 422, code: "policy_violation" });
    // nothing changed on the refused share
    expect(await one<{ scope: string; ownership: string }>("SELECT scope, ownership FROM contacts WHERE id=$1", [mine.contactId])).toMatchObject({ scope: "personal", ownership: "personal" });
    // sharing as a personal (non-company) contact is not gated
    expect(await org.shareContacts(ctx(owner.id), orgId, { contactIds: [mine.contactId], asCompanyLead: false })).toMatchObject({ shared: 1 });
    await expect(org.convertToCompanyLead(ctx(owner.id), orgId, mine.contactId)).rejects.toMatchObject({ status: 422 });
    await expect(org.createLead(ctx(member.id), orgId, org.leadInput.parse({ fullName: "현장리드" }))).rejects.toMatchObject({ status: 422 });

    for (const uid of [owner.id, member.id]) {
      await q("INSERT INTO integration_accounts (user_id, provider, scopes, encrypted_credentials, status) VALUES ($1,'hubspot','{}',$2,'active')", [uid, integration.seal({ access_token: "t" })]);
    }
    const conv = await org.convertToCompanyLead(ctx(owner.id), orgId, mine.contactId);
    expect(conv.ownership).toBe("company");
    const lead = await org.createLead(ctx(member.id), orgId, org.leadInput.parse({ fullName: "현장리드", company: "비" }));
    expect(lead).toMatchObject({ crmSync: { queued: 1 } });
    const other = await relationship.createContact(ctx(owner.id), relationship.contactInput.parse({ fullName: "바로리드" }));
    expect(await org.shareContacts(ctx(owner.id), orgId, { contactIds: [other.contactId], asCompanyLead: true })).toMatchObject({ shared: 1, crmSync: { queued: 1 } });
    for (const id of [mine.contactId, lead.contactId, other.contactId]) {
      const job = await one<{ provider: string; payload: any; job_type: string }>("SELECT provider, payload, job_type FROM sync_jobs WHERE payload->>'contactId'=$1 AND payload->>'policy'='require_crm_sync'", [id]);
      expect(job, id).toMatchObject({ provider: "hubspot" });
      expect(job!.job_type).toMatch(/^crm\.(lead|contact)\.upsert$/);
    }
    // assigning a company lead to a member without the CRM is refused too
    const third = await user("crm-third");
    const inv2 = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "member" }));
    await org.acceptInvite(ctx(third.id), inv2.token);
    await expect(org.assignLead(ctx(owner.id), orgId, lead.contactId, third.id)).rejects.toMatchObject({ status: 422 });
  });
});

describe("F-092 match privacy_penalty from the field ACL", () => {
  it("penalizes candidates whose fields are hidden from the viewer, less once the viewer's audience widens", async () => {
    const viewer = await user("mv");
    await card.saveProfile(ctx(viewer.id), { ...baseProfile, name: "투자찾는이", needs: ["시리즈A 투자 유치"] });
    const open = await user("mo");
    await card.saveProfile(ctx(open.id), { ...baseProfile, name: "공개투자자", offers: ["시리즈A 투자 유치 자문"], fields: [{ type: "website", value: "open.vc", visibility: "public" }] });
    const shy = await user("ms");
    await card.saveProfile(ctx(shy.id), {
      ...baseProfile,
      name: "비공개투자자",
      offers: ["시리즈A 투자 유치 자문"],
      fields: [
        { type: "website", value: "shy.vc", visibility: "public" },
        { type: "email", value: "shy@shy.vc", visibility: "business" },
        { type: "mobile", value: "010-0000-0000", visibility: "private" },
      ],
    });
    for (const target of [open, shy]) {
      const c = await relationship.createContact(ctx(viewer.id), relationship.contactInput.parse({ fullName: `연결-${target.id.slice(0, 4)}` }));
      await q("UPDATE contacts SET linked_user_id=$2 WHERE id=$1", [c.contactId, target.id]);
    }
    const byName = async () => Object.fromEntries((await ai.listMatches(ctx(viewer.id))).results.map((r) => [r.candidateName, r]));
    const m1 = await byName();
    expect(m1["공개투자자"]!.privacyPenalty).toBe(0);
    expect(m1["비공개투자자"]!.privacyPenalty).toBeGreaterThan(0); // 2 of 3 fields hidden from a public audience
    expect(m1["비공개투자자"]!.score).toBeLessThan(m1["공개투자자"]!.score);
    // the candidate adds the viewer as a contact → business audience → only the private field stays hidden
    const back = await relationship.createContact(ctx(shy.id), relationship.contactInput.parse({ fullName: "투자찾는이" }));
    await q("UPDATE contacts SET linked_user_id=$2 WHERE id=$1", [back.contactId, viewer.id]);
    const m2 = await byName();
    expect(m2["비공개투자자"]!.privacyPenalty).toBeGreaterThan(0);
    expect(m2["비공개투자자"]!.privacyPenalty).toBeLessThan(m1["비공개투자자"]!.privacyPenalty);
  });
});

describe("F-096 / F-089 pre-meeting brief history", () => {
  it("adds the previous meeting's stored facts and the contact's changes since then — nothing generated", async () => {
    const u = await user("brief");
    const c = await relationship.createContact(ctx(u.id), relationship.contactInput.parse({ fullName: "브리프상대", company: "옛회사", jobTitle: "과장" }));
    const fresh = await relationship.createContact(ctx(u.id), relationship.contactInput.parse({ fullName: "처음만남" }));
    const past = new Date(Date.now() - 20 * 864e5).toISOString();
    const m1 = await meeting.saveMeeting(ctx(u.id), meeting.meetingInput.parse({ title: "1차 미팅", startedAt: past, participantContactIds: [c.contactId], decisions: ["파일럿 2개월"], promises: [{ text: "견적서 송부", by: "me" }], discussion: ["도입 일정"] }));
    await q("UPDATE meetings SET summary = summary || jsonb_build_object('ai', jsonb_build_object('summary', '파일럿 범위 합의', 'provenance', 'ai_inferred', 'recordingId', NULL)) WHERE id=$1", [m1.id]);
    await relationship.updateContact(ctx(u.id), c.contactId, { jobTitle: "부장" });
    const next = await meeting.saveMeeting(ctx(u.id), meeting.meetingInput.parse({ title: "2차 미팅", startedAt: new Date(Date.now() + 864e5).toISOString(), participantContactIds: [c.contactId, fresh.contactId] }));

    const brief = await meeting.getMeetingBrief(ctx(u.id), next.id);
    const p = brief.people.find((x) => x.contactId === c.contactId)!;
    expect(p.previousMeeting).toMatchObject({
      meetingId: m1.id,
      title: "1차 미팅",
      decisions: ["파일럿 2개월"],
      promises: [{ text: "견적서 송부", by: "me" }],
      discussion: ["도입 일정"],
      transcriptSummary: { text: "파일럿 범위 합의", provenance: "ai_inferred" },
      transcriptExcerpt: [],
      source: "meeting_card",
    });
    expect(p.profileChanges).toEqual([expect.objectContaining({ field: "jobTitle", from: "과장", to: "부장", source: "contact_history" })]);
    expect(p.changesSince).toBe(new Date(past).toISOString());
    // first meeting with someone: no history is invented
    const q2 = brief.people.find((x) => x.contactId === fresh.contactId)!;
    expect(q2.previousMeeting).toBeNull();
    expect(q2.profileChanges).toEqual([]);
  });
});

describe("F-166 audit — team bulk read, storage purge", () => {
  it("listTeamContacts writes a counts-only audit entry; the retention purge goes through the chained writer", async () => {
    const owner = await user("aud");
    const orgId = (await org.createOrg(ctx(owner.id), { name: `감사 ${stamp}` })).id;
    const c = await relationship.createContact(ctx(owner.id), relationship.contactInput.parse({ fullName: "비밀이름", email: "secret@corp.io" }));
    await org.shareContacts(ctx(owner.id), orgId, { contactIds: [c.contactId], asCompanyLead: false });
    const rows = await org.listTeamContacts(ctx(owner.id), orgId, { query: "비밀" });
    expect(rows).toHaveLength(1);
    const a = await one<{ metadata: any; organization_id: string; actor_user_id: string }>("SELECT metadata, organization_id, actor_user_id FROM audit_logs WHERE action='org.team_contacts_read' AND organization_id=$1 ORDER BY id DESC LIMIT 1", [orgId]);
    expect(a).toMatchObject({ organization_id: orgId, actor_user_id: owner.id, metadata: { rows: 1, filtered: true, pii: true } });
    expect(JSON.stringify(a!.metadata)).not.toMatch(/비밀|secret/);

    const obj = await files.storeGeneratedObject({ ownerUserId: owner.id, purpose: "privacy_export", bytes: Buffer.from("{}"), contentType: "application/json", filename: "x.json", retentionDays: 1 });
    await q("UPDATE stored_objects SET retention_until = now() - interval '1 day' WHERE id=$1", [obj.id]);
    await files.purgeExpiredObjects();
    const p = await one<{ chain_seq: string | null; hash: string | null; metadata: any }>("SELECT chain_seq::text, hash, metadata FROM audit_logs WHERE action='storage.retention_purge' ORDER BY id DESC LIMIT 1");
    expect(p!.metadata.count).toBeGreaterThanOrEqual(1);
    expect(p!.chain_seq).not.toBeNull(); // linked into the §20 hash chain at write time
    expect(p!.hash).toMatch(/^[0-9a-f]{64}$/);
    const src = readFileSync(resolve(__dirname, "../src/modules/files.ts"), "utf8");
    expect(src).not.toMatch(/INSERT INTO audit_logs/);
  });
});

describe("F-168 데이터 이동성 — exportMyData queued job (04_OPENAPI 202 Queued)", () => {
  it("queues, is built by the worker into encrypted storage, serves a signed download with the same data; owner-only", async () => {
    const u = await user("exp");
    await relationship.createContact(ctx(u.id), relationship.contactInput.parse({ fullName: "내보낼사람", email: "e@x.io" }));
    const job = await security.requestPrivacyExport(ctx(u.id));
    expect(job).toMatchObject({ status: "queued", downloadUrl: null, statusUrl: `/api/v1/me/privacy/export/${job.id}` });
    expect((await security.getPrivacyExport(ctx(u.id), job.id)).status).toBe("queued");
    const stranger = await user("exp-x");
    await expect(security.getPrivacyExport(ctx(stranger.id), job.id)).rejects.toMatchObject({ status: 404 });

    expect(await security.processPrivacyExports()).toBeGreaterThanOrEqual(1);
    const done = await security.getPrivacyExport(ctx(u.id), job.id);
    expect(done.status).toBe("done");
    const url = new URL(done.downloadUrl!, "https://linkos.test");
    const id = url.pathname.split("/").at(-1)!;
    const file = await files.downloadSigned(id, url.searchParams.get("exp"), url.searchParams.get("sig"));
    expect(file.contentType).toBe("application/json");
    const exported = JSON.parse(file.bytes.toString("utf8"));
    const direct = JSON.parse(JSON.stringify(await security.exportMyData(ctx(u.id))));
    const { exportedAt: _a, ...a } = exported;
    const { exportedAt: _b, ...b } = direct;
    expect(a).toEqual(b);
    expect(exported.contacts.map((c: { full_name: string }) => c.full_name)).toEqual(["내보낼사람"]);
    // the stored object is encrypted at rest and expires with the job
    const so = await one<{ purpose: string; retention_until: Date }>("SELECT purpose, retention_until FROM stored_objects WHERE id=$1", [id]);
    expect(so!.purpose).toBe("privacy_export");
    expect(so!.retention_until.getTime()).toBeGreaterThan(Date.now());
    expect(await one("SELECT 1 FROM audit_logs WHERE action='privacy.export' AND actor_user_id=$1", [u.id])).toBeTruthy();

    // deprecated inline form for the pre-job UI: same job record, data returned in the body
    const legacy = await security.requestPrivacyExportInline(ctx(u.id));
    expect(legacy.status).toBe("done");
    expect((legacy.data as { contacts: unknown[] }).contacts).toHaveLength(1);
  });
});

describe("F-191 seats on every way into an organization", () => {
  it("invite accept, domain auto-join, join approval and SCIM provisioning stop at the seat limit (402 / SCIM 403)", async () => {
    const domain = `seat${stamp}.io`;
    const owner = await user("seat-own", domain);
    const orgId = (await org.createOrg(ctx(owner.id), { name: `좌석 ${stamp}` })).id;
    await org.addDomain(ctx(owner.id), orgId, domain);

    // an org without a subscription has no seat cap (pre-billing behaviour); a paid 1-seat plan holds only the owner
    const free = await user("seat-free", domain);
    const freeInv = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "member" }));
    await org.acceptInvite(ctx(free.id), freeInv.token);
    await q("UPDATE organization_members SET status='removed' WHERE organization_id=$1 AND user_id=$2", [orgId, free.id]);
    await grantSeats(orgId, 1);
    const invited = await user("seat-inv", domain);
    const inv = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "member" }));
    await expect(org.acceptInvite(ctx(invited.id), inv.token)).rejects.toMatchObject({ status: 402, details: { metric: "seats" } });
    expect(await one("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2", [orgId, invited.id])).toBeNull();
    expect((await one<{ use_count: number }>("SELECT use_count FROM org_invites WHERE id=$1", [inv.id]))!.use_count).toBe(0);

    await org.updateOrg(ctx(owner.id), orgId, { domainJoinMode: "auto" });
    const auto = await user("seat-auto", domain);
    await expect(org.joinByDomain(ctx(auto.id), orgId)).rejects.toMatchObject({ status: 402 });

    await org.updateOrg(ctx(owner.id), orgId, { domainJoinMode: "approval" });
    const req = await user("seat-req", domain);
    expect(await org.joinByDomain(ctx(req.id), orgId)).toEqual({ status: "pending" }); // a request takes no seat
    await expect(org.approveMember(ctx(owner.id), orgId, req.id, true)).rejects.toMatchObject({ status: 402 });
    expect(await org.approveMember(ctx(owner.id), orgId, req.id, false)).toEqual({ status: "rejected" }); // rejecting needs no seat

    await enterprise.saveSsoConfig(ctx(owner.id), orgId, { issuer: `https://idp.${domain}`, clientId: "c", enabled: false, defaultRole: "member" });
    await enterprise.rotateScimToken(ctx(owner.id), orgId);
    const scimErr = await enterprise.scimCreate(orgId, { userName: `scim1@${domain}`, active: true }).catch((e) => e);
    expect(scimErr).toBeInstanceOf(enterprise.ScimError);
    expect(scimErr.status).toBe(403);
    expect(scimErr.toJSON()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "403" });
    expect(scimErr.toJSON().detail).toMatch(/seat/);
    // an inactive provisioning takes no seat
    expect(await enterprise.scimCreate(orgId, { userName: `scim-off@${domain}`, active: false })).toMatchObject({ active: false });
    // just-in-time SSO membership (OIDC/SAML login of a new member) takes a seat too — refused, nothing is created
    const { completeSsoLogin } = await import("../src/modules/ssoLogin");
    const jit = { orgId, email: `jit@${domain}`, provider: `oidc:${orgId}`, subject: "jit-1", consents, defaultRole: "member" as const, method: "oidc_sso" as const };
    await expect(tx((c) => completeSsoLogin(c, ctx(null), jit))).rejects.toMatchObject({ status: 402 });
    expect(await one("SELECT 1 FROM users WHERE email=$1", [jit.email])).toBeNull();

    // the paid plan's seats are enforced exactly: 3 seats → 2 more members, then 402 again
    await q("UPDATE subscriptions SET seats=3 WHERE organization_id=$1", [orgId]);
    await org.acceptInvite(ctx(invited.id), inv.token);
    await org.updateOrg(ctx(owner.id), orgId, { domainJoinMode: "auto" });
    expect(await org.joinByDomain(ctx(auto.id), orgId)).toEqual({ status: "active" });
    const fourth = await user("seat-4", domain);
    const inv4 = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "member" }));
    await expect(org.acceptInvite(ctx(fourth.id), inv4.token)).rejects.toMatchObject({ status: 402, details: { limit: 3, used: 3 } });
    await expect(enterprise.scimCreate(orgId, { userName: `scim2@${domain}`, active: true })).rejects.toMatchObject({ status: 403 });
  });
});
