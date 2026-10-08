// UX-011/UX-012 person-page backend paths (real PostgreSQL, DATABASE_URL=…/linkos_test_people):
// F-078/F-109 POST /followups is idempotent (Idempotency-Key), F-070 tags-only PATCH replaces the set without a version bump,
// F-067 manual encounter moves last_contact_at.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_people";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { identity, meeting, relationship, withIdempotency, closePool, q, one } = api;

const ctx = (userId: string | null) => ({ userId, ip: "10.0.0.9", userAgent: "vitest", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];

let userId = "";
let contactId = "";

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes CASCADE");
  const { devCode } = await identity.requestOtp(ctx(null), "people-gaps@linkos.test");
  userId = (await identity.verifyOtp(ctx(null), "people-gaps@linkos.test", devCode!, consents)).user.id;
  contactId = (await relationship.createContact(ctx(userId), relationship.contactInput.parse({ fullName: "김민지", company: "메디파트너스" }))).contactId;
});
afterAll(async () => {
  await closePool();
});

describe("F-078/F-109 followups POST with Idempotency-Key", () => {
  // mirrors apps/web/src/app/api/v1/followups/route.ts
  const post = (key: string | null, body: unknown) =>
    withIdempotency(`followup:${userId}`, key, body, async () => ({ status: 201, body: await meeting.createFollowup(ctx(userId), meeting.followupInput.parse(body)) }));

  it("replays the same key without creating a duplicate, and stores dueAt on the relationship", async () => {
    const dueAt = new Date(Date.now() + 3 * 864e5).toISOString();
    const body = { contactId, kind: "send_material", title: "제안서 보내기", dueAt };
    const a = await post("fu-key-1", body);
    const b = await post("fu-key-1", body);
    expect(a.status).toBe(201);
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM followups WHERE owner_user_id=$1 AND contact_id=$2 AND title='제안서 보내기'", [userId, contactId]);
    expect(n!.n).toBe(1);
    const rel = await one<{ next_followup_at: Date }>("SELECT next_followup_at FROM relationships WHERE owner_user_id=$1 AND contact_id=$2", [userId, contactId]);
    expect(rel!.next_followup_at.toISOString()).toBe(dueAt);
    const t = await relationship.contactTimeline(userId, contactId);
    expect(t.followups.find((f: any) => f.title === "제안서 보내기")).toMatchObject({ kind: "send_material", status: "open", source: "user" });
  });

  it("a different key creates a second task; an invalid body is rejected", async () => {
    await post("fu-key-2", { contactId, title: "안부 묻기" });
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM followups WHERE owner_user_id=$1", [userId]);
    expect(n!.n).toBe(2);
    expect(() => meeting.followupInput.parse({ contactId, title: "" })).toThrow();
    expect(() => meeting.followupInput.parse({ contactId, title: "x", dueAt: "2026-10-10" })).toThrow(); // date input must be converted to ISO datetime
  });
});

describe("F-070 tags-only PATCH", () => {
  it("adds and removes tags without bumping the contact version", async () => {
    const before = await relationship.getContactRow(userId, contactId);
    const added = await relationship.updateContact(ctx(userId), contactId, relationship.contactInput.partial().parse({ tags: ["VIP", "의료"] }));
    expect(added.tags).toEqual(["VIP", "의료"]);
    const removed = await relationship.updateContact(ctx(userId), contactId, relationship.contactInput.partial().parse({ tags: ["의료"] }));
    expect(removed.tags).toEqual(["의료"]);
    expect(removed.version).toBe(before.version);
    const listed = await relationship.listContacts(userId, { tag: "의료" });
    expect(listed.map((c) => c.id)).toContain(contactId);
    expect(await relationship.listContacts(userId, { tag: "VIP" })).toHaveLength(0);
  });
});

describe("F-067 manual encounter", () => {
  it("records place/note/date and appears on the timeline", async () => {
    const occurredAt = new Date(Date.now() - 2 * 864e5).toISOString();
    await relationship.addEncounter(ctx(userId), contactId, { placeLabel: "코엑스 라운지", note: "투자 이야기", occurredAt });
    const t = await relationship.contactTimeline(userId, contactId);
    const e = t.encounters.find((x: any) => x.place_label === "코엑스 라운지");
    expect(e).toMatchObject({ source: "manual", note: "투자 이야기" });
    expect(new Date(e.occurred_at).toISOString()).toBe(occurredAt);
  });
});
