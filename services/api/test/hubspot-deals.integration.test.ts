// F-121 HubSpot — Company/Deal sync (F-127 mapping, F-128 journal) against the local fake HubSpot (test/fakeCrm.ts).
// Deals are drafts until the user approves the exact version (CLAUDE.md rule 8).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCrm, startFakeCrm } from "./fakeCrm";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 13).toString("base64");
process.env.HUBSPOT_CLIENT_ID = "hubspot-client";
process.env.HUBSPOT_CLIENT_SECRET = "hubspot-secret";
process.env.SALESFORCE_CLIENT_ID = "salesforce-client";
process.env.SALESFORCE_CLIENT_SECRET = "salesforce-secret";

let fake: FakeCrm;
const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { identity, relationship, meeting, crm, crmHubspot, withIdempotency, q, one, closePool } = api;
const ctx = (userId: string | null) => ({ userId, ip: "10.21.0.1", userAgent: "test", requestId: "t" });

async function user(prefix: string) {
  const email = `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}@test.io`;
  delete process.env.SMTP_URL;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true })))).user;
}
async function contact(uid: string, fullName: string, extra: Record<string, unknown> = {}) {
  return (await relationship.createContact(ctx(uid), { fullName, source: "manual", provenance: {}, ...extra })).contactId;
}
async function connectHubspot(uid: string) {
  const { url } = crm.crmAuthUrl("hubspot", uid);
  const p = new URL(url).searchParams;
  expect(p.get("scope")).toContain("crm.objects.deals.write");
  expect(p.get("scope")).toContain("crm.objects.companies.write");
  await crm.completeCrmOAuth("hubspot", ctx(uid), "auth-code", p.get("state")!);
}
const companiesNamed = (name: string) => [...fake.hs.companies.values()].filter((c) => c.properties.name === name);
const hsContactByEmail = (email: string) => [...fake.hs.contacts.values()].find((c) => c.properties.email === email)!;

beforeAll(async () => {
  fake = await startFakeCrm();
  process.env.HUBSPOT_API_BASE = fake.url;
  process.env.SALESFORCE_API_BASE = fake.url;
  await migrate();
});
afterAll(async () => {
  await fake.close();
  await closePool();
});

describe("F-121 HubSpot companies (dedupe by domain, association, updatedAt guard)", () => {
  let uid: string;
  let kim: string;
  it("F-127 company/deal settings: defaults, validation, custom pipeline/stage mapping", async () => {
    uid = (await user("hsco")).id;
    await connectHubspot(uid);
    const s = await crmHubspot.getHubspotSettings(uid);
    expect(s.company.isDefault).toBe(true);
    expect(s.deal.pipeline).toEqual({ pipeline: "default", stages: expect.objectContaining({ won: "closedwon" }) });
    await expect(crmHubspot.saveHubspotSettings(ctx(uid), "hubspot", crmHubspot.settingsInput.parse({ object: "deal", entries: [{ local: "dealName", remote: "dealname" }, { local: "description", remote: "dealstage" }] }))).rejects.toMatchObject({
      code: "invalid_mapping",
      details: expect.arrayContaining(["reserved_remote:dealstage"]),
    });
    await expect(
      crmHubspot.saveHubspotSettings(ctx(uid), "hubspot", crmHubspot.settingsInput.parse({ object: "deal", entries: s.deal.defaults, pipeline: { pipeline: "default", stages: { discovery: "x" } } })),
    ).rejects.toMatchObject({ code: "invalid_mapping" });
    await expect(crmHubspot.saveHubspotSettings(ctx(uid), "salesforce", crmHubspot.settingsInput.parse({ object: "company", entries: s.company.defaults }))).rejects.toMatchObject({ code: "deals_unsupported" });
    const saved = await crmHubspot.saveHubspotSettings(
      ctx(uid),
      "hubspot",
      crmHubspot.settingsInput.parse({ object: "deal", entries: s.deal.defaults, pipeline: { pipeline: "enterprise", stages: { ...s.deal.defaultPipeline.stages, proposal: "ent_proposal", negotiation: "ent_negotiation" } } }),
    );
    expect(saved.deal).toMatchObject({ isDefault: false, pipeline: { pipeline: "enterprise", stages: { proposal: "ent_proposal" } } });
  });

  it("one company per domain; contacts upserted and associated; free-mail contacts dedupe by name; existing remote companies are linked, not overwritten", async () => {
    kim = await contact(uid, "Kim Acme", { email: "kim@acme.io", company: "Acme" });
    const lee = await contact(uid, "Lee Acme", { email: "lee@acme.io", company: "Acme" });
    await contact(uid, "Park Beta", { email: "park.beta@gmail.com", company: "Beta Corp" });
    await contact(uid, "Choi Gamma", { email: "choi@gmail.com", company: "Gamma", website: "https://www.gamma.io" });
    await contact(uid, "No Company", { email: "solo@solo.io" });
    const beta = fake.hs.seedCompany({ name: "Beta Corp", city: "Seoul" });
    const gamma = fake.hs.seedCompany({ name: "Gamma Holdings", domain: "gamma.io" });

    const r = await crmHubspot.syncCompanies(ctx(uid), "hubspot", {});
    expect(r).toMatchObject({ queued: 4, total: 4, statuses: { done: 4 } }); // the contact without a company is not queued
    const acme = companiesNamed("Acme");
    expect(acme).toHaveLength(1);
    expect(acme[0]!.properties).toMatchObject({ name: "Acme", domain: "acme.io" });
    expect(fake.hs.associations.has(`contacts:${hsContactByEmail("kim@acme.io").id}->companies:${acme[0]!.id}`)).toBe(true);
    expect(fake.hs.associations.has(`contacts:${hsContactByEmail("lee@acme.io").id}->companies:${acme[0]!.id}`)).toBe(true);
    // free-mail domain never used for dedupe → matched the existing "Beta Corp" by name, remote values untouched
    expect(companiesNamed("Beta Corp")).toHaveLength(1);
    expect(beta.properties).toEqual({ name: "Beta Corp", city: "Seoul" });
    expect(fake.hs.associations.has(`contacts:${hsContactByEmail("park.beta@gmail.com").id}->companies:${beta.id}`)).toBe(true);
    // website domain matched the existing HubSpot company; its name is not overwritten by LINKOS
    expect(gamma.properties.name).toBe("Gamma Holdings");
    expect(companiesNamed("Gamma")).toHaveLength(0);
    expect(r.companies).toBe(3);
    // no PII in the company search/creation payload beyond mapped company fields
    const created = fake.calls.filter((c) => c.method === "POST" && c.path === "/hs/crm/v3/objects/companies");
    expect(created).toHaveLength(1);
    expect(Object.keys(created[0]!.body.properties).sort()).toEqual(["domain", "name"]);

    // idempotent: same contact versions → nothing queued, no new companies
    const again = await crmHubspot.syncCompanies(ctx(uid), "hubspot", {});
    expect(again.queued).toBe(0);
    expect(fake.hs.companies.size).toBe(3);
    // unchanged values → no PATCH on a later version bump
    await relationship.updateContact(ctx(uid), lee, { jobTitle: "CTO" });
    const patchesBefore = fake.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/hs/crm/v3/objects/companies/")).length;
    expect((await crmHubspot.syncCompanies(ctx(uid), "hubspot", { contactIds: [lee] })).queued).toBe(1);
    expect(fake.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/hs/crm/v3/objects/companies/")).length).toBe(patchesBefore);
  });

  it("remote company edit → conflict in the journal; overwrite only after the user resolves it", async () => {
    const acme = companiesNamed("Acme")[0]!;
    fake.hs.touchAny(acme.id, { name: "ACME (edited in HubSpot)" });
    await relationship.updateContact(ctx(uid), kim, { jobTitle: "VP" });
    const r = await crmHubspot.syncCompanies(ctx(uid), "hubspot", { contactIds: [kim] });
    expect(r.statuses.conflict).toBe(1);
    expect(acme.properties.name).toBe("ACME (edited in HubSpot)");
    const entry = (await crm.syncJournal(uid, crm.journalQuery.parse({ provider: "hubspot", status: "conflict" }))).entries.find((e) => e.jobType === "crm.company.upsert")!;
    expect(entry).toMatchObject({ canResolve: true, external: { id: acme.id } });
    await crm.resolveConflict(ctx(uid), entry.id, "overwrite");
    expect(acme.properties.name).toBe("Acme");
    expect(await one("SELECT status, resolution FROM sync_jobs WHERE id=$1", [entry.id])).toEqual({ status: "done", resolution: "overwrite_approved" });
  });
});

describe("F-121 HubSpot deals (draft → explicit approval → sync)", () => {
  let uid: string;
  let mid: string;
  let dealId: string;
  it("meeting outcome → draft only; nothing is sent until approval of the exact version", async () => {
    uid = (await user("hsdeal")).id;
    await connectHubspot(uid);
    await crmHubspot.saveHubspotSettings(ctx(uid), "hubspot", crmHubspot.settingsInput.parse({ object: "deal", entries: (await crmHubspot.getHubspotSettings(uid)).deal.defaults, pipeline: { pipeline: "sales2", stages: { discovery: "s_disc", qualified: "s_qual", proposal: "s_prop", negotiation: "s_nego", won: "s_won", lost: "s_lost" } } }));
    const a = await contact(uid, "Jin Delta", { email: "jin@delta.io", company: "Delta" });
    const b = await contact(uid, "Sora Delta", { email: "sora@delta.io", company: "Delta" });
    mid = (await meeting.saveMeeting(ctx(uid), meeting.meetingInput.parse({ title: "분기 리뷰", participantContactIds: [a, b], decisions: ["PoC 3개월 진행"] }))).id;
    const jobsBefore = (await q("SELECT 1 FROM sync_jobs j JOIN integration_accounts ia ON ia.id=j.integration_account_id WHERE ia.user_id=$1", [uid])).length;
    const d = await crmHubspot.createDealDraft(ctx(uid), "hubspot", crmHubspot.dealDraftInput.parse({ meetingId: mid }));
    dealId = d.id;
    expect(d).toMatchObject({ status: "draft", version: 1, name: "Delta · 분기 리뷰", amount: null, closeDate: null, stage: "discovery", sync: null, external: null });
    expect(d.contactIds.sort()).toEqual([a, b].sort());
    expect(d.description).toContain("결정: PoC 3개월 진행");
    expect(fake.hs.deals.size).toBe(0);
    expect((await q("SELECT 1 FROM sync_jobs j JOIN integration_accounts ia ON ia.id=j.integration_account_id WHERE ia.user_id=$1", [uid])).length).toBe(jobsBefore);

    // the user edits before approving; approving the version they did not see is refused
    const edited = await crmHubspot.updateDeal(ctx(uid), dealId, crmHubspot.dealPatchInput.parse({ amount: 1200000, currency: "KRW", closeDate: "2026-12-15", stage: "proposal" }));
    expect(edited).toMatchObject({ version: 2, status: "draft", amount: 1200000, closeDate: "2026-12-15" });
    await expect(crmHubspot.approveDeal(ctx(uid), dealId, { version: 1 })).rejects.toMatchObject({ status: 409, code: "stale_version" });
    expect(fake.hs.deals.size).toBe(0);
  });

  it("approve → HubSpot deal with mapped pipeline/stage, contacts + company associated; journal entry; re-approve refused", async () => {
    const d = await crmHubspot.approveDeal(ctx(uid), dealId, { version: 2 });
    expect(d).toMatchObject({ status: "synced", sync: { status: "done" }, approvedVersion: 2 });
    const [deal] = [...fake.hs.deals.values()];
    expect(deal!.properties).toMatchObject({ dealname: "Delta · 분기 리뷰", amount: "1200000", closedate: "2026-12-15T00:00:00.000Z", pipeline: "sales2", dealstage: "s_prop", deal_currency_code: "KRW" });
    expect(d.external).toEqual({ id: deal!.id, url: `https://app.hubspot.com/contacts/4242/record/0-3/${deal!.id}` });
    const delta = companiesNamed("Delta");
    expect(delta).toHaveLength(1);
    const assoc = deal!.associations as { to: { id: string }; types: { associationTypeId: number }[] }[];
    expect(assoc.filter((x) => x.types[0]!.associationTypeId === 3).map((x) => x.to.id).sort()).toEqual([hsContactByEmail("jin@delta.io").id, hsContactByEmail("sora@delta.io").id].sort());
    expect(assoc.find((x) => x.types[0]!.associationTypeId === 5)!.to.id).toBe(delta[0]!.id);
    const j = (await crm.syncJournal(uid, crm.journalQuery.parse({ provider: "hubspot" }))).entries.find((e) => e.jobType === "crm.deal.upsert")!;
    expect(j).toMatchObject({ status: "done", deal: { id: dealId, name: "Delta · 분기 리뷰" }, external: { id: deal!.id } });
    await expect(crmHubspot.approveDeal(ctx(uid), dealId, { version: 2 })).rejects.toMatchObject({ code: "deal_already_synced" });
    expect(fake.hs.deals.size).toBe(1);
    expect((await crmHubspot.listDeals(uid, { meetingId: mid })).deals.map((x) => x.id)).toEqual([dealId]);
  });

  it("edit after sync → draft again; remote change → conflict; overwrite only on user resolution", async () => {
    const [deal] = [...fake.hs.deals.values()];
    const e = await crmHubspot.updateDeal(ctx(uid), dealId, crmHubspot.dealPatchInput.parse({ stage: "negotiation" }));
    expect(e).toMatchObject({ status: "draft", version: 3, external: { id: deal!.id } });
    expect(deal!.properties.dealstage).toBe("s_prop"); // not pushed without approval
    fake.hs.touchAny(deal!.id, { amount: "999" });
    const r = await crmHubspot.approveDeal(ctx(uid), dealId, { version: 3 });
    expect(r).toMatchObject({ status: "approved", sync: { status: "conflict" } });
    expect(deal!.properties.dealstage).toBe("s_prop");
    await expect(crmHubspot.approveDeal(ctx(uid), dealId, { version: 3 })).rejects.toMatchObject({ code: "deal_already_approved" });
    await crm.resolveConflict(ctx(uid), r.sync!.jobId, "overwrite");
    expect(deal!.properties).toMatchObject({ dealstage: "s_nego", amount: "1200000" });
    expect(await crmHubspot.getDeal(uid, dealId)).toMatchObject({ status: "synced", sync: { status: "done" } });
    expect(fake.hs.deals.size).toBe(1); // updated in place, never duplicated
  });

  it("the job refuses any version that was not approved (no silent push)", async () => {
    const acct = await one<{ id: string }>("SELECT id FROM integration_accounts WHERE user_id=$1 AND provider='hubspot'", [uid]);
    await crmHubspot.updateDeal(ctx(uid), dealId, crmHubspot.dealPatchInput.parse({ name: "Delta 확장" })); // v4 draft
    await expect(crm.runSyncJob(acct!.id, { id: "x", job_type: "crm.deal.upsert", payload: { dealId, version: 4 } })).rejects.toMatchObject({ code: "deal_not_approved" });
    await expect(crm.runSyncJob(acct!.id, { id: "x", job_type: "crm.deal.upsert", payload: { dealId, version: 3 } })).rejects.toMatchObject({ code: "deal_not_approved" });
    expect([...fake.hs.deals.values()][0]!.properties.dealname).toBe("Delta · 분기 리뷰");
  });

  it("discard, idempotent create (Idempotency-Key), not-connected / missing scopes / other providers", async () => {
    const run = () => withIdempotency(`crm-deal:create:${uid}`, "idem-key-1", { meetingId: mid }, async () => ({ status: 201, body: await crmHubspot.createDealDraft(ctx(uid), "hubspot", crmHubspot.dealDraftInput.parse({ meetingId: mid })) }));
    const first = await run();
    const second = await run();
    expect(second).toMatchObject({ replayed: true, body: { id: first.body.id } });
    expect((await crmHubspot.listDeals(uid, { meetingId: mid })).deals).toHaveLength(2);
    await crmHubspot.discardDeal(ctx(uid), first.body.id);
    await expect(crmHubspot.approveDeal(ctx(uid), first.body.id, { version: 1 })).rejects.toMatchObject({ code: "deal_discarded" });
    await expect(crmHubspot.discardDeal(ctx(uid), dealId)).rejects.toMatchObject({ code: "deal_already_synced" });
    expect(fake.hs.deals.size).toBe(1);

    const other = (await user("hsno")).id;
    await expect(crmHubspot.createDealDraft(ctx(other), "hubspot", crmHubspot.dealDraftInput.parse({ name: "x" }))).rejects.toMatchObject({ status: 409, code: "hubspot_not_connected" });
    await expect(crmHubspot.createDealDraft(ctx(uid), "salesforce", crmHubspot.dealDraftInput.parse({ name: "x" }))).rejects.toMatchObject({ code: "deals_unsupported" });
    await expect(crmHubspot.createDealDraft(ctx(other), "hubspot", crmHubspot.dealDraftInput.parse({ meetingId: mid }))).rejects.toMatchObject({ code: "hubspot_not_connected" });
    await connectHubspot(other);
    await expect(crmHubspot.createDealDraft(ctx(other), "hubspot", crmHubspot.dealDraftInput.parse({ meetingId: mid }))).rejects.toMatchObject({ status: 404 }); // someone else's meeting
    // an account connected before the companies/deals scopes existed must reconnect
    await q("UPDATE integration_accounts SET scopes=$2 WHERE user_id=$1 AND provider='hubspot'", [other, ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"]]);
    await expect(crmHubspot.createDealDraft(ctx(other), "hubspot", crmHubspot.dealDraftInput.parse({ name: "x" }))).rejects.toMatchObject({ code: "hubspot_scope_missing" });
    expect((await crm.crmStatus(other)).find((s) => s.provider === "hubspot")!.capabilities).toMatchObject({ deals: false, companies: false });
    expect((await crm.crmStatus(uid)).find((s) => s.provider === "hubspot")!.capabilities).toMatchObject({ deals: true, companies: true });
  });

  it("audit log records the deal lifecycle (drafted, edited, approved, discarded)", async () => {
    const audits = await q<{ action: string }>("SELECT action FROM audit_logs WHERE actor_user_id=$1 AND action LIKE 'integration.hubspot.deal_%' ORDER BY id", [uid]);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["integration.hubspot.deal_drafted", "integration.hubspot.deal_edited", "integration.hubspot.deal_approved", "integration.hubspot.deal_discarded"]));
  });
});
