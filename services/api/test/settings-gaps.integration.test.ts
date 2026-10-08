// Settings/Org/Team/Messages/Push gaps (real PostgreSQL). Env: DATABASE_URL (default linkos).
// F-125 export period + fact-only reports · F-137/F-166 내 활동 기록 paging · F-129 org delete (owner only)
// F-134/F-138 my membership prefs · F-076 team note delete · F-106 draft cancel · F-110 push history reason
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantSeats } from "./seats";
import { encounterMaintenance } from "./encounterMaintenance";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos";
process.env.RATE_LIMIT_DISABLED = "1";
for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "SMTP_URL"]) delete process.env[k];

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { card, comms, identity, integration, meeting, org, push, relationship, security, closePool, q, one } = api;

const ctx = (userId: string | null) => ({ userId, ip: "10.7.0.1", userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
const stamp = Date.now();
let n = 0;
async function user(prefix = "s") {
  const email = `${prefix}${stamp}-${n++}@settings-gaps.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}
const text = (b: Buffer | string) => (Buffer.isBuffer(b) ? b.toString("utf8") : b);

let me: { id: string };
let oldContact: string;
let newContact: string;

beforeAll(async () => {
  await migrate();
  me = await user("owner");
  oldContact = (await relationship.createContact(ctx(me.id), relationship.contactInput.parse({ fullName: "오래된 연락처", company: "옛회사" }))).contactId;
  newContact = (await relationship.createContact(ctx(me.id), relationship.contactInput.parse({ fullName: "새 연락처", company: "새회사", encounter: { placeLabel: "행사" } }))).contactId;
  // backdate the old contact and drop its creation encounter so only created_at decides
  await q("UPDATE contacts SET created_at='2024-03-01T00:00:00Z' WHERE id=$1", [oldContact]);
  await encounterMaintenance("DELETE FROM encounters WHERE contact_id=$1", [oldContact]);
});
afterAll(async () => {
  for (let i = 0; i < 50 && (await relayOutbox(500)) > 0; i++);
  await closePool();
});

async function download(input: Record<string, unknown>) {
  const job = await integration.createExport(ctx(me.id), integration.exportInput.parse(input));
  return integration.renderExport(ctx(me.id), job.id);
}

describe("F-125 export period (since/until)", () => {
  it("without a period exports everything; with a period only contacts added or met within it", async () => {
    const all = text((await download({ format: "csv", fields: ["fullName"] })).body);
    expect(all).toContain("오래된 연락처");
    expect(all).toContain("새 연락처");

    const recent = text((await download({ format: "csv", fields: ["fullName"], since: new Date(Date.now() - 30 * 864e5).toISOString() })).body);
    expect(recent).toContain("새 연락처");
    expect(recent).not.toContain("오래된 연락처");

    const old = text((await download({ format: "csv", fields: ["fullName"], since: "2024-01-01", until: "2024-03-01" })).body);
    expect(old).toContain("오래된 연락처"); // date-only until includes that whole day
    expect(old).not.toContain("새 연락처");

    // an encounter inside the period brings the old contact back into a recent export
    await relationship.addEncounter(ctx(me.id), oldContact, { placeLabel: "카페", occurredAt: new Date().toISOString() });
    const again = text((await download({ format: "csv", fields: ["fullName"], since: new Date(Date.now() - 864e5).toISOString() })).body);
    expect(again).toContain("오래된 연락처");
  });

  it("stores the period on the job and audits it; rejects since > until and reports in non-tabular formats", async () => {
    const job = await integration.createExport(ctx(me.id), integration.exportInput.parse({ format: "json", fields: ["fullName"], since: "2025-01-01", until: "2025-12-31" }));
    const row = await one<{ params: Record<string, string> }>("SELECT params FROM export_jobs WHERE id=$1", [job.id]);
    expect(row!.params).toEqual({ since: "2025-01-01", until: "2025-12-31" });
    const a = await one<{ metadata: Record<string, unknown> }>("SELECT metadata FROM audit_logs WHERE action='export.created' AND entity_id=$1", [job.id]);
    expect(a!.metadata).toMatchObject({ report: "contacts", period: true });
    expect(integration.exportInput.safeParse({ format: "csv", since: "2025-02-01", until: "2025-01-01" }).success).toBe(false);
    expect(integration.exportInput.safeParse({ format: "pdf", report: "meetings" }).success).toBe(false);
    expect(integration.exportInput.safeParse({ format: "csv", since: "not-a-date" }).success).toBe(false);
  });
});

describe("F-125 fact-only reports", () => {
  it("meetings report lists title/date/participants/purpose and never the AI or discussion text", async () => {
    await meeting.saveMeeting(
      ctx(me.id),
      meeting.meetingInput.parse({ title: "킥오프 미팅", purpose: "파일럿 범위 합의", startedAt: new Date().toISOString(), participantContactIds: [newContact], discussion: ["비밀 논의 내용"] }),
    );
    await meeting.saveMeeting(ctx(me.id), meeting.meetingInput.parse({ title: "작년 미팅", startedAt: "2024-05-01T10:00:00Z" }));
    const f = await download({ format: "csv", report: "meetings", since: new Date(Date.now() - 864e5).toISOString() });
    expect(f.filename).toMatch(/^linkos-meetings-.*\.csv$/);
    const csv = text(f.body);
    expect(csv.split("\r\n")[0]).toBe("﻿제목,날짜,상대,회사,목적,다음 미팅");
    expect(csv).toContain("킥오프 미팅");
    expect(csv).toContain("새 연락처");
    expect(csv).toContain("파일럿 범위 합의");
    expect(csv).not.toContain("작년 미팅");
    expect(csv).not.toContain("비밀 논의 내용");
  });

  it("relationships report has strength / encounter count / last encounter per contact", async () => {
    await q("UPDATE relationships SET strength=72 WHERE owner_user_id=$1 AND contact_id=$2", [me.id, newContact]);
    const csv = text((await download({ format: "csv", report: "relationships" })).body);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("﻿이름,회사,직책,관계 강도,만남 횟수,마지막 만남,최근 연락,다음 후속,상태");
    const row = lines.find((l) => l.startsWith("새 연락처"))!;
    expect(row).toBeTruthy();
    expect(row.split(",")[3]).toBe("72");
    expect(Number(row.split(",")[4])).toBeGreaterThanOrEqual(1);
    const xlsx = await download({ format: "xlsx", report: "relationships" });
    expect(xlsx.contentType).toContain("spreadsheetml");
  });
});

describe("F-137 / F-166 my audit log", () => {
  it("is keyset-paged and only exposes allow-listed metadata", async () => {
    const p1 = await security.myAuditLog(me.id, { limit: 2 });
    expect(p1.entries).toHaveLength(2);
    expect(p1.nextCursor).toBe(p1.entries[1]!.id);
    const p2 = await security.myAuditLog(me.id, { limit: 2, before: p1.nextCursor });
    expect(p2.entries.length).toBeGreaterThan(0);
    expect(BigInt(p2.entries[0]!.id) < BigInt(p1.entries[1]!.id)).toBe(true);
    const exp = (await security.myAuditLog(me.id, { limit: 100 })).entries.find((e) => e.action === "export.created")!;
    expect(Object.keys(exp.metadata).every((k) => ["format", "report", "period", "rows", "provider", "queued", "count", "role", "strategy", "type"].includes(k))).toBe(true);
    // garbage cursor is ignored, not an SQL error
    expect((await security.myAuditLog(me.id, { before: "1; DROP TABLE x" })).entries.length).toBeGreaterThan(0);
  });
});

describe("F-129 / F-134 / F-138 / F-076 org", () => {
  it("member prefs round-trip; team note delete is author-only; org delete is owner-only and audited", async () => {
    const owner = await user("orgowner");
    const member = await user("orgmember");
    await card.saveProfile(ctx(member.id), { ...base, name: "멤버" });
    const o = await org.createOrg(ctx(owner.id), { name: `설정 테스트 ${stamp}` });
    await grantSeats(o.id);
    const inv = await org.createInvite(ctx(owner.id), o.id, { role: "member", maxUses: 1, ttlDays: 1 });
    await org.acceptInvite(ctx(member.id), inv.token);

    // joining attaches the primary card to the org (default on); the flag mirrors that
    expect((await org.getOrg(ctx(member.id), o.id)).showBrandingOnCard).toBe(true);
    await org.updateMyMembership(ctx(member.id), o.id, { graphOptOut: true, showBrandingOnCard: true });
    let info = await org.getOrg(ctx(member.id), o.id);
    expect(info.graphOptOut).toBe(true);
    expect(info.showBrandingOnCard).toBe(true);
    await org.updateMyMembership(ctx(member.id), o.id, { showBrandingOnCard: false });
    info = await org.getOrg(ctx(member.id), o.id);
    expect(info.showBrandingOnCard).toBe(false);

    const c = await relationship.createContact(ctx(owner.id), relationship.contactInput.parse({ fullName: "공유 상대" }));
    await org.shareContacts(ctx(owner.id), o.id, { contactIds: [c.contactId], asCompanyLead: false });
    const note = await org.addTeamNote(ctx(member.id), o.id, c.contactId, "멤버의 팀 메모");
    const other = await org.addTeamNote(ctx(owner.id), o.id, c.contactId, "오너의 팀 메모");
    await expect(org.deleteTeamNote(ctx(member.id), o.id, other.id)).rejects.toMatchObject({ status: 403 });
    expect(await org.deleteTeamNote(ctx(member.id), o.id, note.id)).toEqual({ deleted: true });

    await expect(org.deleteOrg(ctx(member.id), o.id)).rejects.toMatchObject({ status: 403 });
    expect(await org.deleteOrg(ctx(owner.id), o.id)).toEqual({ deleted: true });
    expect(await one("SELECT 1 FROM organizations WHERE id=$1", [o.id])).toBeNull();
    expect(await one("SELECT 1 FROM audit_logs WHERE action='org.deleted' AND entity_id=$1 AND actor_user_id=$2", [o.id, owner.id])).toBeTruthy();
  });
});

describe("F-106 draft cancel · F-110 push history", () => {
  it("cancels a draft once; a cancelled draft cannot be cancelled again", async () => {
    const m = await comms.createMessage(ctx(me.id), comms.messageInput.parse({ contactId: newContact, toAddress: "x@example.com", subject: "안녕하세요", body: "초안 본문" }));
    expect(m.status).toBe("draft");
    expect((await comms.cancelMessage(ctx(me.id), m.id)).status).toBe("cancelled");
    await expect(comms.cancelMessage(ctx(me.id), m.id)).rejects.toMatchObject({ status: 409 });
  });

  it("lists push deliveries with their skip reason", async () => {
    await push.notify(api.pool(), me.id, { kind: "followup", title: "후속 리마인더", body: "테스트" });
    await push.processPushQueue(50);
    const list = (await push.listNotifications(me.id)) as { title: string; status: string; reason: string | null }[];
    const it0 = list.find((x) => x.title === "후속 리마인더")!;
    expect(it0.status).toBe("skipped");
    expect(it0.reason).toBe("vapid_not_configured");
  });
});
