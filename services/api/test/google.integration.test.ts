// F-113/F-114/F-117/F-128: Google OAuth, People API sync (idempotent, etag), Sheets export — against a fake Google.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeGoogle, startFakeGoogle } from "./fakeGoogle";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 9).toString("base64");

let g: FakeGoogle;
const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { identity, integration, relationship, q, one, closePool } = api;
const ctx = (userId: string | null) => ({ userId, ip: "10.1.1.1", userAgent: "test", requestId: "t" });

async function user(email: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true })))).user;
}

beforeAll(async () => {
  g = await startFakeGoogle();
  process.env.GOOGLE_API_BASE = g.url;
  await migrate();
});
afterAll(async () => {
  await g.close();
  await closePool();
});

describe("Google integration (fake Google)", () => {
  let uid: string;
  it("OAuth: signed state, code exchange, encrypted credential storage, consent record", async () => {
    uid = (await user(`g${Date.now()}@test.io`)).id;
    const { url } = integration.googleAuthUrl("sheets", uid);
    expect(url).toContain("drive.file");
    expect(url).not.toContain("auth/spreadsheets"); // least privilege
    const state = new URL(url).searchParams.get("state")!;
    expect(integration.verifyState(state)).toMatchObject({ purpose: "sheets", userId: uid });
    expect(() => integration.verifyState(state.replace(/.$/, (c) => (c === "x" ? "y" : "x")))).toThrow();
    const { tok, user: gu } = await integration.exchangeGoogleCode("code-abc");
    expect(gu.email).toBe("fake@gmail.com");
    await integration.storeGoogleAccount(uid, tok);
    const row = await one<{ encrypted_credentials: Buffer }>("SELECT encrypted_credentials FROM integration_accounts WHERE user_id=$1", [uid]);
    expect(row!.encrypted_credentials.toString()).not.toContain("refresh-1");
    const consent = await one("SELECT 1 FROM consent_records WHERE subject_user_id=$1 AND consent_type='integration_google' AND granted", [uid]);
    expect(consent).toBeTruthy();
    expect((await integration.integrationStatus(uid)).sheetsConnected).toBe(true);
  });

  it("Contacts sync: create once, idempotent re-enqueue, update with etag after edit", async () => {
    const c = await relationship.createContact(ctx(uid), { fullName: "김구글", company: "구글코리아", email: "kim@g.co", source: "manual", provenance: {} });
    const first = await integration.enqueueGoogleContactSync(ctx(uid));
    expect(first.queued).toBe(1);
    expect((await integration.enqueueGoogleContactSync(ctx(uid))).queued).toBe(0); // same version → no duplicate job
    expect(await integration.processSyncJobs()).toBe(1);
    expect(g.people.size).toBe(1);
    const map = await one<{ external_id: string; external_etag: string }>("SELECT external_id, external_etag FROM external_mappings WHERE local_id=$1", [c.contactId]);
    expect(map!.external_id).toMatch(/^people\/c/);

    await relationship.updateContact(ctx(uid), c.contactId, { jobTitle: "이사" });
    await relayOutbox(); // contact.updated → versioned sync job via outbox consumer
    expect(await integration.processSyncJobs()).toBe(1);
    expect(g.people.size).toBe(1); // updated, not duplicated
    const [p] = [...g.people.values()];
    expect(p!.person.organizations[0].title).toBe("이사");
  });

  it("transient failure retries with backoff, then succeeds", async () => {
    await relationship.createContact(ctx(uid), { fullName: "재시도", source: "manual", provenance: {} });
    await integration.enqueueGoogleContactSync(ctx(uid));
    g.failNext(503);
    await integration.processSyncJobs();
    const job = await one<{ status: string; attempt_count: number }>(
      "SELECT j.status, j.attempt_count FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id WHERE a.user_id=$1 ORDER BY j.scheduled_at DESC LIMIT 1",
      [uid],
    );
    expect(job).toMatchObject({ status: "retry", attempt_count: 1 });
    await q("UPDATE sync_jobs SET scheduled_at=now() WHERE status='retry'");
    expect(await integration.processSyncJobs()).toBe(1);
  });

  it("expired access token is refreshed transparently", async () => {
    await q("UPDATE integration_accounts SET encrypted_credentials=$2 WHERE user_id=$1", [uid, integration.seal({ access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() - 1000 })]);
    g.expireAccess();
    await relationship.createContact(ctx(uid), { fullName: "리프레시", source: "manual", provenance: {} });
    await integration.enqueueGoogleContactSync(ctx(uid));
    expect(await integration.processSyncJobs()).toBeGreaterThan(0);
    expect(g.calls.some((c) => c.path === "/token" && c.body.grant_type === "refresh_token")).toBe(true);
  });

  it("Sheets export: new spreadsheet, selected fields only, RAW values (no formula execution)", async () => {
    await relationship.createContact(ctx(uid), { fullName: "=IMPORTXML(\"http://evil\")", email: "x@y.io", phone: "010-0000-0000", source: "manual", provenance: {} });
    const r = await integration.exportToGoogleSheets(ctx(uid), { fields: ["fullName", "company", "email"] });
    expect(r.url).toContain("docs.google.com/spreadsheets");
    const sheet = g.sheets.get(r.spreadsheetId)!;
    expect(sheet.title).toMatch(/^LINKOS 연락처/);
    expect(sheet.values[0]).toEqual(["fullName", "company", "email"]);
    expect(sheet.values.length).toBe(r.rows + 1);
    expect(JSON.stringify(sheet.values)).not.toContain("010-0000-0000"); // phone not selected
    const put = g.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toContain("valueInputOption=RAW");
  });

  it("Sheets export requires the sheets scope; revoked refresh → reauth state", async () => {
    const other = (await user(`ns${Date.now()}@test.io`)).id;
    await expect(integration.exportToGoogleSheets(ctx(other), { fields: ["fullName"] })).rejects.toMatchObject({ code: "google_sheets_not_connected" });
    g.failNext(400);
    await q("UPDATE integration_accounts SET encrypted_credentials=$2 WHERE user_id=$1", [uid, integration.seal({ access_token: "old", refresh_token: "revoked", expires_at: 0 })]);
    await expect(integration.exportToGoogleSheets(ctx(uid), { fields: ["fullName"] })).rejects.toMatchObject({ code: "google_reauth_required" });
    expect((await one<{ status: string }>("SELECT status FROM integration_accounts WHERE user_id=$1", [uid]))!.status).toBe("reauth_required");
  });
});
