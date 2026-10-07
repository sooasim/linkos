// Track A integration tests (real PostgreSQL): Organization / Enterprise / Relationship graph / Introductions / Passkey / SSO.
// Uses its own database (linkos_test_a). External IdP is a local fake OIDC server; WebAuthn uses a software authenticator.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOidc } from "./fakeOidc";
import { createSoftAuthenticator } from "./softAuthenticator";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_a";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.LLM_DISABLED = "1";
process.env.SSO_ALLOW_HTTP_ISSUER = "1";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { tick } = await import("../src/worker");
const { card, connection, enterprise, growth, handoff, identity, integration, intro, meeting, network, org, passkey, relationship, security, closePool, q, one } = api;

type Ctx = { userId: string | null; ip: string; userAgent: string; requestId: string };
const ctx = (userId: string | null): Ctx => ({ userId, ip: "10.0.0.9", userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
async function signUp(email: string, name?: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  const r = await identity.verifyOtp(ctx(null), email, devCode!, consents, name);
  return r.user;
}
const baseProfile = {
  company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
  theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [] as string[], needs: [] as string[], variants: [],
};
async function contact(userId: string, fullName: string, extra: Record<string, unknown> = {}) {
  const r = await relationship.createContact(ctx(userId), relationship.contactInput.parse({ fullName, ...extra }));
  return r.contactId;
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; status?: number }) => e.code ?? String(e.status));

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, exchange_sessions, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes, events, deletion_requests, webauthn_challenges CASCADE");
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------------------------
describe("F-129 조직/워크스페이스 + F-004 조직 가입", () => {
  let owner: { id: string };
  let orgId: string;

  it("creates an org (creator = owner, becomes active workspace) and switches workspace", async () => {
    owner = await signUp("ceo@acme-a.io", "대표");
    const o = await org.createOrg(ctx(owner.id), { name: "Acme Korea" });
    orgId = o.id;
    expect(o).toMatchObject({ role: "owner", slug: "acme-korea" });
    expect((await org.listMyOrgs(owner.id)).activeOrgId).toBe(orgId);
    await org.setActiveOrg(ctx(owner.id), null);
    expect((await org.listMyOrgs(owner.id)).activeOrgId).toBeNull();
    await org.setActiveOrg(ctx(owner.id), orgId);
    const stranger = await signUp("stranger@else.io");
    // tenant isolation: non-members can neither read nor switch into the org (404, existence not revealed)
    expect(await code(org.getOrg(ctx(stranger.id), orgId))).toBe("not_found");
    expect(await code(org.setActiveOrg(ctx(stranger.id), orgId))).toBe("not_found");
    const a = await one<{ action: string }>("SELECT action FROM audit_logs WHERE organization_id=$1 AND action='org.created'", [orgId]);
    expect(a).toBeTruthy();
  });

  it("invite link: email-bound, single use, expiry, revoke", async () => {
    const inv = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ email: "dev@acme-a.io", role: "member" }));
    expect(inv.url).toMatch(/^https:\/\/linkos\.test\/join\//);
    expect(await org.previewInvite(inv.token)).toMatchObject({ orgName: "Acme Korea", role: "member", emailBound: true, usable: true });
    const other = await signUp("other@acme-a.io");
    expect(await code(org.acceptInvite(ctx(other.id), inv.token))).toBe("forbidden");
    const dev = await signUp("dev@acme-a.io");
    expect(await org.acceptInvite(ctx(dev.id), inv.token)).toMatchObject({ role: "member", alreadyMember: false });
    expect(await org.acceptInvite(ctx(dev.id), inv.token)).toMatchObject({ alreadyMember: true });
    expect(await code(org.acceptInvite(ctx(other.id), inv.token))).toBe("invite_used");
    // revoked + expired invites
    const open = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "viewer", maxUses: 5 }));
    await org.revokeInvite(ctx(owner.id), orgId, open.id);
    expect(await code(org.acceptInvite(ctx(other.id), open.token))).toBe("invite_revoked");
    const exp = await org.createInvite(ctx(owner.id), orgId, org.inviteInput.parse({ role: "viewer", maxUses: 5 }));
    await q("UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE id=$1", [exp.id]);
    expect(await code(org.acceptInvite(ctx(other.id), exp.token))).toBe("invite_expired");
    expect(await code(org.acceptInvite(ctx(other.id), "not-a-token"))).toBe("not_found");
    const statuses = (await org.listInvites(ctx(owner.id), orgId)).map((i: any) => i.status).sort();
    expect(statuses).toEqual(["expired", "revoked", "used"]);
  });

  it("verified email domain: only the admin's own (non-webmail) domain; auto-join and approval modes", async () => {
    expect(await code(org.addDomain(ctx(owner.id), orgId, "gmail.com"))).toBe("domain_not_verified");
    expect(await code(org.addDomain(ctx(owner.id), orgId, "other.io"))).toBe("domain_not_verified");
    expect(await org.addDomain(ctx(owner.id), orgId, "acme-a.io")).toMatchObject({ domain: "acme-a.io", verified: true });
    const someone = await signUp("someone@acme-a.io");
    expect((await org.listMyOrgs(someone.id)).discoverable).toEqual([]); // mode off
    await org.updateOrg(ctx(owner.id), orgId, { domainJoinMode: "auto" });
    expect((await org.listMyOrgs(someone.id)).discoverable).toEqual([{ id: orgId, name: "Acme Korea", mode: "join" }]);
    expect(await org.joinByDomain(ctx(someone.id), orgId)).toEqual({ status: "active" });
    const outsider = await signUp("x@outsider.io");
    expect(await code(org.joinByDomain(ctx(outsider.id), orgId))).toBe("not_found");

    await org.updateOrg(ctx(owner.id), orgId, { domainJoinMode: "approval" });
    const pend = await signUp("pending@acme-a.io");
    expect(await org.joinByDomain(ctx(pend.id), orgId)).toEqual({ status: "pending" });
    expect(await code(org.listTeamContacts(ctx(pend.id), orgId))).toBe("not_found"); // pending ≠ member
    await org.approveMember(ctx(owner.id), orgId, pend.id, true);
    expect(await org.listTeamContacts(ctx(pend.id), orgId)).toEqual([]);
    const rej = await signUp("reject@acme-a.io");
    await org.joinByDomain(ctx(rej.id), orgId);
    await org.approveMember(ctx(owner.id), orgId, rej.id, false);
    expect(await code(org.getOrg(ctx(rej.id), orgId))).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-130 역할 권한 — every role enforced in services", () => {
  const u: Record<string, { id: string }> = {};
  let orgId: string;
  let ownerContact: string;
  let lead: string;

  beforeAll(async () => {
    u.owner = await signUp("owner@rbac.io");
    orgId = (await org.createOrg(ctx(u.owner.id), { name: "RBAC Co" })).id;
    for (const role of ["admin", "manager", "member", "viewer"] as const) {
      u[role] = await signUp(`${role}@rbac.io`, role);
      const inv = await org.createInvite(ctx(u.owner.id), orgId, org.inviteInput.parse({ role }));
      await org.acceptInvite(ctx(u[role]!.id), inv.token);
    }
    for (const t of ["t1", "t2", "t3"]) {
      u[t] = await signUp(`${t}@rbac.io`);
      const inv = await org.createInvite(ctx(u.owner.id), orgId, org.inviteInput.parse({ role: "member" }));
      await org.acceptInvite(ctx(u[t]!.id), inv.token);
    }
    ownerContact = await contact(u.owner.id, "김공유", { company: "Target Inc", email: "kim@target.io", phone: "010-1111-2222" });
    await org.shareContacts(ctx(u.owner.id), orgId, { contactIds: [ownerContact], asCompanyLead: false });
    lead = (await org.createLead(ctx(u.owner.id), orgId, org.leadInput.parse({ fullName: "회사리드", company: "Lead Corp", email: "lead@lead.io" }))).contactId;
  });

  it("team address book: everyone reads; PII hidden from viewer", async () => {
    for (const r of ["owner", "admin", "manager", "member", "viewer"]) {
      const list = await org.listTeamContacts(ctx(u[r]!.id), orgId);
      expect(list.length).toBe(2);
      const k = list.find((c: any) => c.id === ownerContact)!;
      if (r === "viewer") expect(k).toMatchObject({ email: null, phone: null, piiHidden: true });
      else expect(k.email).toBe("kim@target.io");
    }
  });

  it("write actions follow the role matrix", async () => {
    const results: Record<string, Record<string, string>> = {};
    for (const r of ["owner", "admin", "manager", "member", "viewer"]) {
      const id = u[r]!.id;
      const c = ctx(id);
      const mine = await contact(id, `${r}의 연락처`);
      results[r] = {
        share: await code(org.shareContacts(c, orgId, { contactIds: [mine], asCompanyLead: false })),
        createLead: await code(org.createLead(c, orgId, org.leadInput.parse({ fullName: `${r} lead` }))),
        teamNote: await code(org.addTeamNote(c, orgId, ownerContact, `${r} note`)),
        assignLead: await code(org.assignLead(c, orgId, lead, u.t1!.id)),
        inviteMember: await code(org.createInvite(c, orgId, org.inviteInput.parse({ role: "member" }))),
        inviteManager: await code(org.createInvite(c, orgId, org.inviteInput.parse({ role: "manager" }))),
        graph: await code(network.orgGraph(c, orgId)),
        dashboard: await code(enterprise.orgActivity(c, orgId)),
        policies: await code(enterprise.updatePolicies(c, orgId, {})),
        apiKeys: await code(enterprise.listApiKeys(c, orgId)),
        sso: await code(enterprise.getSsoConfig(c, orgId)),
        audit: await code(enterprise.orgAuditLog(c, orgId)),
        retention: await code(enterprise.previewRetention(c, orgId)),
        branding: await code(org.updateOrg(c, orgId, { branding: { primaryColor: "#112233" } })),
      };
    }
    const ok = (roles: string[]) => Object.fromEntries(["owner", "admin", "manager", "member", "viewer"].map((r) => [r, roles.includes(r) ? "ok" : "forbidden"]));
    const col = (k: string) => Object.fromEntries(Object.entries(results).map(([r, v]) => [r, v[k]]));
    const all = ["owner", "admin", "manager", "member", "viewer"];
    expect(col("share")).toEqual(ok(all.slice(0, 4)));
    expect(col("createLead")).toEqual(ok(all.slice(0, 4)));
    expect(col("teamNote")).toEqual(ok(all.slice(0, 4)));
    expect(col("assignLead")).toEqual(ok(all.slice(0, 3)));
    expect(col("inviteMember")).toEqual(ok(all.slice(0, 3)));
    expect(col("inviteManager")).toEqual(ok(all.slice(0, 2)));
    expect(col("graph")).toEqual(ok(all.slice(0, 4)));
    expect(col("dashboard")).toEqual(ok(all.slice(0, 3)));
    for (const k of ["policies", "apiKeys", "sso", "audit", "retention", "branding"]) expect([k, col(k)]).toEqual([k, ok(all.slice(0, 2))]);
  });

  it("role changes: owner > admin > others; last owner protected; org.delete owner-only", async () => {
    expect(await code(org.changeRole(ctx(u.manager!.id), orgId, u.t2!.id, "viewer"))).toBe("forbidden");
    expect(await code(org.changeRole(ctx(u.member!.id), orgId, u.t2!.id, "viewer"))).toBe("forbidden");
    expect(await code(org.changeRole(ctx(u.viewer!.id), orgId, u.t2!.id, "viewer"))).toBe("forbidden");
    expect(await org.changeRole(ctx(u.admin!.id), orgId, u.t2!.id, "manager")).toMatchObject({ role: "manager" });
    expect(await code(org.changeRole(ctx(u.admin!.id), orgId, u.t2!.id, "admin"))).toBe("forbidden");
    expect(await code(org.changeRole(ctx(u.admin!.id), orgId, u.owner!.id, "member"))).toBe("forbidden");
    expect(await code(org.changeRole(ctx(u.owner!.id), orgId, u.owner!.id, "admin"))).toBe("last_owner");
    expect(await code(org.removeMember(ctx(u.owner!.id), orgId, u.owner!.id, null))).toBe("last_owner");
    expect(await code(org.removeMember(ctx(u.admin!.id), orgId, u.owner!.id, null))).toBe("forbidden");
    expect(await code(org.removeMember(ctx(u.manager!.id), orgId, u.t3!.id, null))).toBe("forbidden");
    expect(await code(org.deleteOrg(ctx(u.admin!.id), orgId))).toBe("forbidden");
    const changes = await q("SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='org.role_changed'", [orgId]);
    expect(changes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-131 팀 주소록 tenant isolation · F-132 회사 소유 리드 · F-077 담당자 · F-076 공유 메모", () => {
  const u: Record<string, { id: string }> = {};
  let X: string;
  let Y: string;
  let lead: string;
  let personal: string;

  beforeAll(async () => {
    u.ownerX = await signUp("owner@x-corp.io", "X오너");
    u.salesX = await signUp("sales@x-corp.io", "X영업");
    u.sales2X = await signUp("sales2@x-corp.io", "X영업2");
    u.ownerY = await signUp("owner@y-corp.io", "Y오너");
    X = (await org.createOrg(ctx(u.ownerX.id), { name: "X Corp" })).id;
    Y = (await org.createOrg(ctx(u.ownerY.id), { name: "Y Corp" })).id;
    for (const k of ["salesX", "sales2X"]) {
      const inv = await org.createInvite(ctx(u.ownerX.id), X, org.inviteInput.parse({ role: "member" }));
      await org.acceptInvite(ctx(u[k]!.id), inv.token);
    }
  });

  it("isolates org X data from org Y", async () => {
    personal = await contact(u.salesX!.id, "박개인", { company: "Partner Ltd", email: "park@partner.io" });
    await org.shareContacts(ctx(u.salesX!.id), X, { contactIds: [personal], asCompanyLead: false });
    lead = (await org.createLead(ctx(u.salesX!.id), X, org.leadInput.parse({ fullName: "이리드", company: "Buyer Co", email: "lee@buyer.io" }))).contactId;
    const ycontact = await contact(u.ownerY!.id, "Y의 고객", { company: "Buyer Co" });
    await org.shareContacts(ctx(u.ownerY!.id), Y, { contactIds: [ycontact], asCompanyLead: false });

    expect((await org.listTeamContacts(ctx(u.ownerX!.id), X)).map((c: any) => c.fullName).sort()).toEqual(["박개인", "이리드"]);
    expect((await org.listTeamContacts(ctx(u.ownerY!.id), Y)).map((c: any) => c.fullName)).toEqual(["Y의 고객"]);
    // Y's owner cannot reach X through any org endpoint, nor via X's contact ids on Y's org id
    const y = ctx(u.ownerY!.id);
    for (const p of [() => org.listTeamContacts(y, X), () => org.getTeamContact(y, X, lead), () => network.orgGraph(y, X), () => network.whoKnows(y, X, "Buyer"), () => org.listTeamNotes(y, X, lead)]) {
      expect(await code(p())).toBe("not_found");
    }
    expect(await code(org.getTeamContact(ctx(u.ownerY!.id), Y, lead))).toBe("not_found");
    expect(await code(org.addTeamNote(ctx(u.ownerY!.id), Y, lead, "침투"))).toBe("not_found");
    expect(await code(org.assignLead(ctx(u.ownerY!.id), Y, lead, u.ownerY!.id))).toBe("not_found");
    // cannot share someone else's contact, nor a contact already shared to another org
    expect(await code(org.shareContacts(ctx(u.ownerY!.id), Y, { contactIds: [lead], asCompanyLead: false }))).toBe("not_found");
    // Y's personal contact list never includes X's data
    expect((await relationship.listContacts(u.ownerY!.id)).map((c) => c.fullName)).toEqual(["Y의 고객"]);
  });

  it("F-076: team notes shared with the team; private notes never leave their author", async () => {
    await relationship.addNote(ctx(u.salesX!.id), lead, "개인 메모: 협상 하한가 3억");
    await org.addTeamNote(ctx(u.salesX!.id), X, lead, "팀 메모: 다음 주 데모 예정");
    const view = await org.getTeamContact(ctx(u.sales2X!.id), X, lead);
    expect(view.notes.map((n: any) => n.body)).toEqual(["팀 메모: 다음 주 데모 예정"]);
    expect(JSON.stringify(view)).not.toContain("하한가");
    expect((await org.listTeamNotes(ctx(u.ownerX!.id), X, lead)).map((n: any) => n.author)).toEqual(["X영업"]);
    expect(await code(org.deleteTeamNote(ctx(u.sales2X!.id), X, view.notes[0].id))).toBe("forbidden");
  });

  it("F-077 / F-132: assignment and departure reassign company leads; personal contacts leave with the person", async () => {
    expect(await code(org.assignLead(ctx(u.ownerX!.id), X, personal, u.sales2X!.id))).toBe("personal_contact");
    expect(await code(org.unshareContact(ctx(u.ownerX!.id), X, lead))).toBe("company_owned");
    // salesX leaves; lead goes to sales2X with its timeline; private note does NOT follow
    const r = await org.removeMember(ctx(u.ownerX!.id), X, u.salesX!.id, u.sales2X!.id);
    expect(r).toMatchObject({ leadsReassigned: 1, reassignedTo: u.sales2X!.id, personalUnshared: 1 });
    const t = await relationship.contactTimeline(u.sales2X!.id, lead);
    expect(t.contact.fullName).toBe("이리드");
    expect(t.encounters.length).toBe(1);
    expect(JSON.stringify(t.notes)).not.toContain("하한가");
    expect(await code(relationship.getContactRow(u.salesX!.id, lead))).toBe("not_found");
    // personal contact is the leaver's again and gone from the team book
    expect((await org.listTeamContacts(ctx(u.ownerX!.id), X)).map((c: any) => c.fullName)).toEqual(["이리드"]);
    expect((await relationship.getContactRow(u.salesX!.id, personal)).fullName).toBe("박개인");
    expect(await code(org.listTeamContacts(ctx(u.salesX!.id), X))).toBe("not_found");
    const lst = (await org.listTeamContacts(ctx(u.ownerX!.id), X))[0]!;
    expect(lst.owner.userId).toBe(u.sales2X!.id);
    expect(await one("SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='org.member_departed'", [X])).toBeTruthy();
  });

  it("F-132: account deletion keeps company leads in the org (reassigned) while personal data is deleted", async () => {
    const leaving = await signUp("bye@x-corp.io");
    const inv = await org.createInvite(ctx(u.ownerX!.id), X, org.inviteInput.parse({ role: "member" }));
    await org.acceptInvite(ctx(leaving.id), inv.token);
    const l2 = (await org.createLead(ctx(leaving.id), X, org.leadInput.parse({ fullName: "남는리드" }))).contactId;
    const mine = await contact(leaving.id, "개인친구");
    await org.addTeamNote(ctx(leaving.id), X, l2, "남겨둘 팀 메모");
    await security.requestDeletion(ctx(leaving.id));
    await q("UPDATE deletion_requests SET deadline = now() - interval '1 minute' WHERE user_id=$1", [leaving.id]);
    await security.processDeletions();
    expect(await one("SELECT 1 FROM users WHERE id=$1", [leaving.id])).toBeNull();
    expect(await one("SELECT 1 FROM contacts WHERE id=$1", [mine])).toBeNull();
    const kept = await one<{ owner_user_id: string; organization_id: string }>("SELECT owner_user_id, organization_id FROM contacts WHERE id=$1", [l2]);
    expect(kept).toMatchObject({ owner_user_id: u.ownerX!.id, organization_id: X });
    expect((await org.listTeamNotes(ctx(u.ownerX!.id), X, l2)).map((n: any) => [n.body, n.author])).toEqual([["남겨둘 팀 메모", "탈퇴한 멤버"]]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-074 관계 강도 · F-098 미접촉 위험 · F-099 Opportunity · F-097/F-152 소개 후보", () => {
  let me: { id: string };
  let a: string;
  let b: string;
  let cold: string;

  beforeAll(async () => {
    me = await signUp("networker@net.io", "네트워커");
    await card.saveProfile(ctx(me.id), { ...baseProfile, name: "네트워커", offers: ["B2B SaaS 영업 자문"] });
    const pa = await signUp("hospital@net.io", "병원장");
    await card.saveProfile(ctx(pa.id), { ...baseProfile, name: "병원장", company: "서울병원", industries: ["헬스케어"], needs: ["의료 AI 영상 판독 파트너"] });
    const pb = await signUp("vendor@net.io", "벤더");
    await card.saveProfile(ctx(pb.id), { ...baseProfile, name: "벤더", company: "메디AI", industries: ["헬스케어"], offers: ["의료 AI 영상 판독 솔루션"] });
    a = await contact(me.id, "병원장", { company: "서울병원" });
    b = await contact(me.id, "벤더", { company: "메디AI" });
    await q("UPDATE contacts SET linked_user_id=$2 WHERE id=$1", [a, pa.id]);
    await q("UPDATE contacts SET linked_user_id=$2 WHERE id=$1", [b, pb.id]);
    cold = await contact(me.id, "오래된VIP", { company: "Old Co", tags: ["VIP"] });
  });

  it("F-074: strength is explainable and grows with meetings/encounters/notes", async () => {
    const before = await network.strengthFor(ctx(me.id), b);
    expect(before.factors.map((f) => f.kind)).toContain("recency");
    for (let i = 0; i < 3; i++) await relationship.addEncounter(ctx(me.id), b, { placeLabel: `미팅 ${i}` });
    await relationship.addNote(ctx(me.id), b, "좋은 파트너");
    await meeting.saveMeeting(ctx(me.id), meeting.meetingInput.parse({ title: "킥오프", participantContactIds: [b] }));
    const after = await network.strengthFor(ctx(me.id), b);
    expect(after.score).toBeGreaterThan(before.score);
    const stored = await one<{ strength: string; strength_factors: unknown[] }>("SELECT strength, strength_factors FROM relationships WHERE contact_id=$1", [b]);
    expect(Number(stored!.strength)).toBe(after.score);
    expect(stored!.strength_factors.length).toBe(6);
    expect(await code(network.strengthFor(ctx((await signUp("nosy@net.io")).id), b))).toBe("not_found");
  });

  it("F-098: cooling relationships (VIP / past cadence) are flagged with reasons", async () => {
    await q("UPDATE encounters SET occurred_at = now() - interval '200 days' WHERE contact_id=$1", [cold]);
    await q("UPDATE relationships SET last_contact_at = now() - interval '200 days' WHERE contact_id=$1", [cold]);
    const r = await network.coolingRelationships(ctx(me.id));
    const hit = r.results.find((x) => x.contactId === cold);
    expect(hit).toMatchObject({ level: "high", provenance: "ai_inferred" });
    expect(hit!.reasons).toContain("VIP 태그");
    expect(r.results.find((x) => x.contactId === b)).toBeUndefined();
  });

  it("F-097 / F-152: intro candidates from Need↔Offer with graph path, labeled ai_inferred; creating one records source", async () => {
    const s = await network.introSuggestions(ctx(me.id));
    expect(s.results.length).toBe(1);
    const c0 = s.results[0]!;
    expect([c0.partyA.id, c0.partyB.id].sort()).toEqual([a, b].sort());
    expect(c0.provenance).toBe("ai_inferred");
    expect(c0.reasons.join(" ")).toContain("의료 AI 영상 판독");
    expect(c0.path).toEqual([c0.partyA.name, "나", c0.partyB.name]);
    const created = await intro.createFromSuggestion(ctx(me.id), { partyAContactId: c0.partyA.id, partyBContactId: c0.partyB.id, reason: c0.reasons[0]! });
    expect(await one("SELECT 1 FROM introductions WHERE id=$1 AND source='ai_suggested'", [created.id])).toBeTruthy();
    expect(await one("SELECT 1 FROM ai_runs WHERE owner_user_id=$1 AND kind='intro_candidates'", [me.id])).toBeTruthy();
  });

  it("F-099: needs from notes/meetings/cards matched with offers in the network (literal evidence only)", async () => {
    await relationship.addNote(ctx(me.id), cold, "내년에 B2B SaaS 영업 자문이 필요하다고 함");
    const o = await network.opportunities(ctx(me.id));
    const kinds = o.results.map((r) => `${r.need.source}:${r.need.personName}->${r.offer.personName}`);
    expect(kinds).toContain("note:오래된VIP->나");
    expect(kinds).toContain("profile_need:병원장->벤더");
    expect(o.results.every((r) => r.provenance === "ai_inferred")).toBe(true);
    const fromNote = o.results.find((r) => r.need.source === "note")!;
    expect(fromNote.need.text).toBe("내년에 B2B SaaS 영업 자문이 필요하다고 함");
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-133 관계 그래프 · F-134 Who Knows Whom", () => {
  it("builds a privacy-aware org graph and strength-ranked who-knows-whom", async () => {
    const boss = await signUp("boss@graph.io", "보스");
    const amy = await signUp("amy@graph.io", "에이미");
    const ben = await signUp("ben@graph.io", "벤");
    const G = (await org.createOrg(ctx(boss.id), { name: "Graph Co" })).id;
    for (const m of [amy, ben]) {
      const inv = await org.createInvite(ctx(boss.id), G, org.inviteInput.parse({ role: "member" }));
      await org.acceptInvite(ctx(m.id), inv.token);
    }
    const shared = await contact(amy.id, "샘삼성", { company: "삼성전자", jobTitle: "상무" });
    for (let i = 0; i < 4; i++) await relationship.addEncounter(ctx(amy.id), shared, {});
    await network.recomputeStrengths(amy.id);
    await org.shareContacts(ctx(amy.id), G, { contactIds: [shared], asCompanyLead: false });
    await contact(ben.id, "비밀연락처", { company: "삼성전자", jobTitle: "과장" });
    await contact(ben.id, "다른회사", { company: "LG전자" });

    const g = await network.orgGraph(ctx(boss.id), G);
    const labels = g.nodes.map((n: any) => n.label);
    expect(labels).toEqual(expect.arrayContaining(["보스", "에이미", "벤", "샘삼성", "삼성전자", "LG전자"]));
    expect(labels).not.toContain("비밀연락처"); // personal contacts only as company-level aggregate
    expect(g.edges.find((e: any) => e.source === `m:${ben.id}` && e.kind === "knows_company")).toBeTruthy();
    for (const n of g.nodes) expect(n.x).toBeGreaterThan(0);

    const w = await network.whoKnows(ctx(boss.id), G, "삼성");
    expect(w.results.map((r: any) => r.memberName)).toEqual(["에이미", "벤"]);
    expect(w.results[0]!.contacts[0]).toMatchObject({ name: "샘삼성", shared: true });
    expect(w.results[1]!.contacts[0]).toMatchObject({ name: null, contactId: null, shared: false });
    expect(await one("SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='org.who_knows'", [G])).toBeTruthy();

    // member opt-out and org policy "shared_only" remove personal aggregates
    await org.updateMyMembership(ctx(ben.id), G, { graphOptOut: true });
    expect((await network.whoKnows(ctx(boss.id), G, "삼성")).results.map((r: any) => r.memberName)).toEqual(["에이미"]);
    await org.updateMyMembership(ctx(ben.id), G, { graphOptOut: false });
    await enterprise.updatePolicies(ctx(boss.id), G, { graphPersonalExposure: "shared_only" });
    const g2 = await network.orgGraph(ctx(boss.id), G);
    expect(g2.privacy).toBe("shared_only");
    expect(g2.nodes.map((n: any) => n.label)).not.toContain("LG전자");
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-155 3자 소개 메시지 · F-158 Room 요약 · F-159 소개 성과", () => {
  it("drafts (never sends) a double-opt-in intro, summarizes the room, tracks outcomes", async () => {
    const host = await signUp("host@intro.io", "호스트");
    await card.saveProfile(ctx(host.id), { ...baseProfile, name: "호스트", company: "링크랩" });
    const a = await contact(host.id, "가나다", { company: "A사", jobTitle: "CTO", email: "a@a.io", phone: "010-9999-0000" });
    const b = await contact(host.id, "라마바", { company: "B사" });
    const i = await connection.createIntroduction(ctx(host.id), { partyAContactId: a, partyBContactId: b, reason: "AI 인프라 협업" });
    const d = await intro.draftIntroMessage(ctx(host.id), i.id);
    expect(d.sent).toBe(false);
    expect(d.draft.provenance).toBe("rules");
    expect(d.draft.toA.body).toContain("라마바");
    expect(d.draft.joint.body).toContain("AI 인프라 협업");
    expect(JSON.stringify(d.draft)).not.toMatch(/010-9999|a@a\.io/);
    const saved = await intro.saveIntroDraft(ctx(host.id), i.id, { ...d.draft, toA: { subject: "수정", body: "직접 고친 본문" } });
    expect(saved.draft).toMatchObject({ provenance: "user", editedByUser: true });
    expect(await code(intro.draftIntroMessage(ctx((await signUp("x@intro.io")).id), i.id))).toBe("not_found");
    expect(await one("SELECT 1 FROM outbox_events WHERE aggregate_id=$1", [i.id])).toBeNull(); // nothing queued for sending

    await connection.recordIntroConsent(ctx(host.id), i.id, "a", true);
    const done = await connection.recordIntroConsent(ctx(host.id), i.id, "b", true);
    const roomId = done.roomId!;
    await connection.postRoomMessage(ctx(host.id), roomId, "결정: 3월에 PoC 진행\n할 일: 견적서 전달\n다음 미팅: 3/15");
    const s = await intro.summarizeRoom(ctx(host.id), roomId);
    expect(s.summary).toMatchObject({ provenance: "rules", decisions: ["3월에 PoC 진행"], openItems: ["견적서 전달"] });
    expect(await one("SELECT 1 FROM connection_rooms WHERE id=$1 AND summary IS NOT NULL", [roomId])).toBeTruthy();

    const m = await intro.setIntroOutcome(ctx(host.id), i.id, { outcome: "meeting", meetingAt: new Date().toISOString() });
    expect(m.state).toBe("MEETING_BOOKED");
    const w = await intro.setIntroOutcome(ctx(host.id), i.id, { outcome: "won", note: "계약" });
    expect(w.state).toBe("WON");
    const c2 = await contact(host.id, "사아자");
    const declined = await connection.createIntroduction(ctx(host.id), { partyAContactId: a, partyBContactId: c2, reason: "x" });
    await connection.recordIntroConsent(ctx(host.id), declined.id, "a", false);
    expect(await code(intro.setIntroOutcome(ctx(host.id), declined.id, { outcome: "won" }))).toBe("intro_declined");
    const st = await intro.introOutcomeStats(ctx(host.id));
    expect(st.all).toMatchObject({ total: 2, won: 1, declined: 1, winRate: 50 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-064 Referral Attribution · F-197 Referral Reward", () => {
  it("attributes guest-claim, org invite and link signups (new accounts only); rewards after activation", async () => {
    process.env.REFERRAL_REWARDS_ENABLED = "1";
    const sender = await signUp("ref-sender@ref.io", "보낸이");
    await card.saveProfile(ctx(sender.id), { ...baseProfile, name: "보낸이" });
    const s = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    const reply = await handoff.replyExchange(s.token, ctx(null), handoff.replyInput.parse({ card: { fullName: "게스트" }, sharedFields: ["fullName"], consent: { exchange: true } }));
    const guest = await signUp("guest@ref.io", "게스트");
    await handoff.claimGuest(ctx(guest.id), reply.claimToken!);
    const att = await one<any>("SELECT * FROM referral_attributions WHERE referred_user_id=$1", [guest.id]);
    expect(att).toMatchObject({ referrer_user_id: sender.id, source: "exchange_claim" });
    expect(JSON.stringify(att)).not.toContain("guest@ref.io");

    // existing users are never attributed
    const old = await signUp("old@ref.io");
    await q("UPDATE users SET created_at = now() - interval '30 days' WHERE id=$1", [old.id]);
    const s2 = await handoff.createExchangeSession(ctx(sender.id), handoff.createSessionInput.parse({}));
    const r2 = await handoff.replyExchange(s2.token, ctx(null), handoff.replyInput.parse({ card: { fullName: "Old" }, sharedFields: ["fullName"], consent: { exchange: true } }));
    await handoff.claimGuest(ctx(old.id), r2.claimToken!);
    expect(await one("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1", [old.id])).toBeNull();

    // link code
    const mine = await growth.myReferrals(ctx(sender.id));
    expect(mine.code).toMatch(/^[A-Z0-9]{8}$/);
    const linked = await signUp("linked@ref.io");
    expect(await growth.attributeSignupByCode(linked.id, mine.code)).toEqual({ attributed: true });
    expect(await growth.attributeSignupByCode(linked.id, mine.code)).toMatchObject({ attributed: false, reason: "already_attributed" });
    expect(await growth.attributeSignupByCode(sender.id, mine.code)).toMatchObject({ attributed: false });

    // org invite
    const boss = await signUp("boss@ref.io");
    const O = (await org.createOrg(ctx(boss.id), { name: "Ref Org" })).id;
    const inv = await org.createInvite(ctx(boss.id), O, org.inviteInput.parse({ role: "member" }));
    const joiner = await signUp("joiner@ref.io");
    await org.acceptInvite(ctx(joiner.id), inv.token);
    expect(await one("SELECT 1 FROM referral_attributions WHERE referred_user_id=$1 AND referrer_user_id=$2 AND source='org_invite'", [joiner.id, boss.id])).toBeTruthy();

    const stats = await growth.myReferrals(ctx(sender.id));
    expect(stats).toMatchObject({ total: 2, bySource: { exchange_claim: 1, link: 1 } });
    expect(stats.recent.every((r: any) => !("email" in r))).toBe(true);
    expect(stats.rewards).toMatchObject({ enabled: true, pending: 200, granted: 0 });

    // reward granted only after the referred user completes an exchange
    await growth.processReferralRewards();
    expect((await growth.myReferrals(ctx(sender.id))).rewards.granted).toBe(0);
    await card.saveProfile(ctx(guest.id), { ...baseProfile, name: "게스트2" }).catch(() => undefined);
    const gs = await handoff.createExchangeSession(ctx(guest.id), handoff.createSessionInput.parse({}));
    await handoff.replyExchange(gs.token, ctx(null), handoff.replyInput.parse({ card: { fullName: "누군가" }, sharedFields: ["fullName"], consent: { exchange: true } }));
    await growth.processReferralRewards();
    expect((await growth.myReferrals(ctx(sender.id))).rewards).toMatchObject({ granted: 100, pending: 100 });
    delete process.env.REFERRAL_REWARDS_ENABLED;
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-135 대시보드 · F-136 Retention · F-138 브랜딩 · F-139 정책 · F-140 API 키", () => {
  const u: Record<string, { id: string }> = {};
  let E: string;

  beforeAll(async () => {
    u.owner = await signUp("owner@ent.io", "엔터오너");
    u.member = await signUp("member@ent.io", "엔터멤버");
    E = (await org.createOrg(ctx(u.owner.id), { name: "Ent Co" })).id;
    const inv = await org.createInvite(ctx(u.owner.id), E, org.inviteInput.parse({ role: "member" }));
    await org.acceptInvite(ctx(u.member.id), inv.token);
  });

  it("F-135: org activity dashboard aggregates member activity", async () => {
    await card.saveProfile(ctx(u.member!.id), { ...baseProfile, name: "엔터멤버" });
    const s = await handoff.createExchangeSession(ctx(u.member!.id), handoff.createSessionInput.parse({}));
    await handoff.replyExchange(s.token, ctx(null), handoff.replyInput.parse({ card: { fullName: "손님" }, sharedFields: ["fullName"], consent: { exchange: true } }));
    await meeting.saveMeeting(ctx(u.member!.id), meeting.meetingInput.parse({ title: "미팅" }));
    const c = await contact(u.member!.id, "공유고객");
    await org.shareContacts(ctx(u.member!.id), E, { contactIds: [c], asCompanyLead: true });
    const d = await enterprise.orgActivity(ctx(u.owner!.id), E, 30);
    const m = d.members.find((x: any) => x.userId === u.member!.id)!;
    expect(m).toMatchObject({ exchanges: 1, exchanges_done: 1, meetings: 1, shared: 1, followups: 1 });
    expect(d.totals.exchanges).toBe(1);
    expect(d.rates.exchangeCompletion).toBe(100);
    expect(d.teamBook).toMatchObject({ shared: 1, leads: 1 });
  });

  it("F-136: retention policy validated, previewed, purged by the worker with an audit record", async () => {
    expect(await code(enterprise.updateRetention(ctx(u.owner!.id), E, { inactiveContactDays: 5 }))).toBe("invalid_retention");
    const oldLead = (await org.createLead(ctx(u.owner!.id), E, org.leadInput.parse({ fullName: "휴면리드" }))).contactId;
    const oldPersonal = await contact(u.member!.id, "휴면개인");
    await org.shareContacts(ctx(u.member!.id), E, { contactIds: [oldPersonal], asCompanyLead: false });
    const fresh = (await org.createLead(ctx(u.owner!.id), E, org.leadInput.parse({ fullName: "활성리드" }))).contactId;
    await org.addTeamNote(ctx(u.owner!.id), E, fresh, "오래된 팀 메모");
    for (const id of [oldLead, oldPersonal]) {
      await q("UPDATE contacts SET updated_at = now() - interval '400 days' WHERE id=$1", [id]);
      await q("UPDATE encounters SET occurred_at = now() - interval '400 days' WHERE contact_id=$1", [id]);
    }
    await q("UPDATE notes SET created_at = now() - interval '200 days' WHERE contact_id=$1 AND scope='team'", [fresh]);
    await enterprise.updateRetention(ctx(u.owner!.id), E, { inactiveContactDays: 365, teamNoteDays: 90 });
    const pv = await enterprise.previewRetention(ctx(u.owner!.id), E);
    expect(pv).toMatchObject({ wouldDelete: { companyLeads: 1, teamNotes: 1 }, wouldUnshare: { personalContacts: 1 } });
    await tick();
    expect(await one("SELECT 1 FROM contacts WHERE id=$1", [oldLead])).toBeNull();
    expect(await one("SELECT scope, organization_id FROM contacts WHERE id=$1", [oldPersonal])).toEqual({ scope: "personal", organization_id: null });
    expect(await one("SELECT 1 FROM contacts WHERE id=$1", [fresh])).toBeTruthy();
    expect(await org.listTeamNotes(ctx(u.owner!.id), E, fresh)).toEqual([]);
    const a = await one<{ metadata: any }>("SELECT metadata FROM audit_logs WHERE organization_id=$1 AND action='retention.purged'", [E]);
    expect(a!.metadata).toMatchObject({ companyLeadsDeleted: 1, personalUnshared: 1, teamNotesDeleted: 1 });
  });

  it("F-138: org branding appears on member Living Cards when enabled", async () => {
    expect(await code(org.updateOrg(ctx(u.owner!.id), E, { branding: { logoUrl: "javascript:alert(1)" } }))).toBe("invalid_branding");
    const p = await card.saveProfile(ctx(u.owner!.id), { ...baseProfile, name: "엔터오너" });
    // profiles created after joining are attached via the member preference
    await org.updateMyMembership(ctx(u.owner!.id), E, { showBrandingOnCard: true });
    expect((await card.getPublicProfileBySlug(p.slug, null)).brand).toBeNull();
    await org.updateOrg(ctx(u.owner!.id), E, { branding: { primaryColor: "#FF5A1F", logoUrl: "https://cdn.ent.io/logo.svg", showOnMemberCards: true } });
    expect((await card.getPublicProfileBySlug(p.slug, null)).brand).toEqual({ orgName: "Ent Co", logoUrl: "https://cdn.ent.io/logo.svg", primaryColor: "#FF5A1F" });
    await org.updateMyMembership(ctx(u.owner!.id), E, { showBrandingOnCard: false });
    expect((await card.getPublicProfileBySlug(p.slug, null)).brand).toBeNull();
  });

  it("F-139: recording consent, export and card-field policies are enforced", async () => {
    await enterprise.updatePolicies(ctx(u.owner!.id), E, { requireAllPartyRecordingConsent: true, blockExportRoles: ["member"], minFieldVisibility: "business" });
    const m = await meeting.saveMeeting(ctx(u.member!.id), meeting.meetingInput.parse({ title: "녹음 회의" }));
    expect(await code(meeting.setRecordingConsent(ctx(u.member!.id), m.id, { ownerConsent: true, participantsAcknowledged: true, policy: "one_party_notice" }))).toBe("policy_violation");
    expect((await meeting.setRecordingConsent(ctx(u.member!.id), m.id, { ownerConsent: true, participantsAcknowledged: true, policy: "all_party" })).consentStatus).toBe("granted");
    expect(await code(integration.createExport(ctx(u.member!.id), integration.exportInput.parse({ format: "csv" })))).toBe("export_blocked_by_policy");
    expect(await code(integration.createExport(ctx(u.owner!.id), integration.exportInput.parse({ format: "csv" })))).toBe("ok");
    const prof = (await card.listMyProfiles(u.member!.id))[0]!;
    await org.updateMyMembership(ctx(u.member!.id), E, { showBrandingOnCard: true });
    const bad = { ...baseProfile, name: "엔터멤버", fields: [{ type: "mobile" as const, value: "010-1234-5678", visibility: "public" as const }] };
    expect(await code(card.saveProfile(ctx(u.member!.id), bad, prof.id))).toBe("policy_violation");
    expect(await code(card.saveProfile(ctx(u.member!.id), { ...bad, fields: [{ ...bad.fields[0]!, visibility: "business" as const }] }, prof.id))).toBe("ok");
    await enterprise.updatePolicies(ctx(u.owner!.id), E, {});
    expect(await code(integration.createExport(ctx(u.member!.id), integration.exportInput.parse({ format: "csv" })))).toBe("ok");
  });

  it("F-140: hashed, scoped, revocable API keys; tenant-isolated reads", async () => {
    const k = await enterprise.createApiKey(ctx(u.owner!.id), E, { name: "CRM sync", scopes: ["leads:read"] });
    expect(k.key).toMatch(/^lk_[A-Za-z0-9]{8}_/);
    const stored = await one<{ key_hash: string }>("SELECT key_hash FROM api_keys WHERE id=$1", [k.id]);
    expect(stored!.key_hash).not.toContain(k.key.slice(12));
    const auth = await enterprise.authenticateApiKey(`Bearer ${k.key}`, "leads:read");
    expect(auth.orgId).toBe(E);
    const leads = await enterprise.apiListContacts(auth, { kind: "leads" });
    expect(leads.map((l: any) => l.fullName)).toContain("공유고객");
    expect(leads.map((l: any) => l.fullName)).not.toContain("이리드"); // another org's lead
    expect(await code(enterprise.authenticateApiKey(`Bearer ${k.key}`, "contacts:read"))).toBe("insufficient_scope");
    expect(await code(enterprise.authenticateApiKey(`Bearer ${k.key}x`, "leads:read"))).toBe("invalid_api_key");
    expect(await code(enterprise.authenticateApiKey(null, "leads:read"))).toBe("invalid_api_key");
    const w = await enterprise.createApiKey(ctx(u.owner!.id), E, { name: "writer", scopes: ["leads:write"] });
    const wa = await enterprise.authenticateApiKey(w.key, "leads:read"); // write implies read
    const created = await enterprise.apiCreateLead(wa, relationship.contactInput.parse({ fullName: "API리드" }));
    expect(await one("SELECT 1 FROM contacts WHERE id=$1 AND organization_id=$2 AND ownership='company'", [created.id, E])).toBeTruthy();
    await enterprise.revokeApiKey(ctx(u.owner!.id), E, k.id);
    expect(await code(enterprise.authenticateApiKey(k.key, "leads:read"))).toBe("invalid_api_key");
    expect(await one("SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='apikey.read'", [E])).toBeTruthy();
    expect((await enterprise.listApiKeys(ctx(u.owner!.id), E)).map((x: any) => x.status).sort()).toEqual(["active", "revoked"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-008 B2B SSO (OIDC) + SCIM 2.0", () => {
  it("logs in via the org's OIDC IdP (PKCE, nonce, JWKS-verified), JIT-joins, rejects forged tokens and foreign domains", async () => {
    const idp = await startFakeOidc("linkos-client", "s3cret");
    try {
      const admin = await signUp("admin@sso-corp.io", "SSO관리자");
      const S = (await org.createOrg(ctx(admin.id), { name: "SSO Corp" })).id;
      await org.addDomain(ctx(admin.id), S, "sso-corp.io");
      const cfg = await enterprise.saveSsoConfig(ctx(admin.id), S, { issuer: idp.issuer, clientId: "linkos-client", clientSecret: "s3cret", enabled: true, defaultRole: "member" });
      expect(cfg).toMatchObject({ configured: true, enabled: true, hasClientSecret: true, saml: "not_supported" });
      expect(JSON.stringify(cfg)).not.toContain("s3cret");

      const start = await enterprise.ssoStart(ctx(null), { email: "new.hire@sso-corp.io", next: "/app/org" });
      expect(start.url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
      // new account: consent is required first (exchange-first / consent principles)
      let cb = await idp.authorize(start.url, { sub: "emp-1", email: "new.hire@sso-corp.io", name: "신입" });
      expect(await code(enterprise.ssoCallback(ctx(null), { ...cb, consents: [] }))).toBe("consent_required");
      const start2 = await enterprise.ssoStart(ctx(null), { org: (await org.getOrg(ctx(admin.id), S)).slug });
      cb = await idp.authorize(start2.url, { sub: "emp-1", email: "new.hire@sso-corp.io", name: "신입" });
      const ok = await enterprise.ssoCallback(ctx(null), { ...cb, consents });
      expect(ok.isNew).toBe(true);
      expect((await identity.resolveSession(ok.sessionToken, ctx(null)))?.userId).toBe(ok.userId);
      expect((await org.getOrg(ctx(ok.userId), S)).role).toBe("member");
      // state is one-time
      expect(await code(enterprise.ssoCallback(ctx(null), { ...cb, consents }))).toBe("invalid_state");

      for (const [opts, user, expected] of [
        [{ nonceOverride: "evil" }, { sub: "emp-2", email: "a@sso-corp.io" }, "sso_nonce_mismatch"],
        [{ signWithOtherKey: true }, { sub: "emp-2", email: "a@sso-corp.io" }, "sso_invalid_token"],
        [{ audOverride: "other-client" }, { sub: "emp-2", email: "a@sso-corp.io" }, "sso_invalid_token"],
        [{}, { sub: "emp-3", email: "spy@elsewhere.io" }, "sso_domain_not_allowed"],
        [{}, { sub: "emp-4", email: "b@sso-corp.io", emailVerified: false }, "sso_email_missing"],
      ] as const) {
        const st = await enterprise.ssoStart(ctx(null), { email: "x@sso-corp.io" });
        const c = await idp.authorize(st.url, user, opts);
        expect([expected, await code(enterprise.ssoCallback(ctx(null), { ...c, consents }))]).toEqual([expected, expected]);
      }
      expect(await code(enterprise.ssoStart(ctx(null), { email: "x@unknown-domain.io" }))).toBe("not_found");
      expect(await one("SELECT 1 FROM audit_logs WHERE action='auth.signup' AND metadata->>'method'='oidc_sso'")).toBeTruthy();
    } finally {
      await idp.close();
    }
  });

  it("SCIM: token auth, provision, filter, deactivate (→ lead reassignment), consent at first login", async () => {
    const admin = await signUp("admin@scim-corp.io", "SCIM관리자");
    const S = (await org.createOrg(ctx(admin.id), { name: "SCIM Corp" })).id;
    await org.addDomain(ctx(admin.id), S, "scim-corp.io");
    expect(await code(enterprise.rotateScimToken(ctx(admin.id), S))).toBe("sso_not_configured");
    await enterprise.saveSsoConfig(ctx(admin.id), S, { issuer: "https://idp.scim-corp.io", clientId: "c", enabled: false, defaultRole: "member" });
    const { token } = await enterprise.rotateScimToken(ctx(admin.id), S);
    await expect(enterprise.scimAuth("Bearer scim_wrong")).rejects.toMatchObject({ status: 401 });
    expect(await enterprise.scimAuth(`Bearer ${token}`)).toBe(S);

    const created = await enterprise.scimCreate(S, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "kim@scim-corp.io", externalId: "okta-1", name: { formatted: "김사원" }, active: true });
    expect(created).toMatchObject({ userName: "kim@scim-corp.io", active: true, externalId: "okta-1", displayName: "김사원" });
    await expect(enterprise.scimCreate(S, { userName: "kim@scim-corp.io" })).rejects.toMatchObject({ status: 409 });
    await expect(enterprise.scimCreate(S, { userName: "spy@other.io" })).rejects.toMatchObject({ status: 400 });
    const list = await enterprise.scimList(S, { filter: 'userName eq "kim@scim-corp.io"' });
    expect(list).toMatchObject({ totalResults: 1, Resources: [{ id: created.id }] });
    expect((await enterprise.scimList(S, { filter: 'externalId eq "okta-1"' })).totalResults).toBe(1);
    await expect(enterprise.scimList(S, { filter: 'name co "x"' })).rejects.toMatchObject({ status: 400 });
    // tenant isolation: another org's SCIM cannot see/patch this user
    const other = await signUp("admin@other-scim.io");
    const O = (await org.createOrg(ctx(other.id), { name: "Other" })).id;
    await expect(enterprise.scimGet(O, created.id)).rejects.toMatchObject({ status: 404 });

    // provisioned user must accept terms at first login
    const { devCode } = await identity.requestOtp(ctx(null), "kim@scim-corp.io");
    await expect(identity.verifyOtp(ctx(null), "kim@scim-corp.io", devCode!, [])).rejects.toMatchObject({ code: "consent_required" });
    const { devCode: c2 } = await identity.requestOtp(ctx(null), "kim@scim-corp.io");
    const login = await identity.verifyOtp(ctx(null), "kim@scim-corp.io", c2!, consents);
    expect(login.user.id).toBe(created.id);

    // deprovision → company leads reassigned to the owner
    const lead = (await org.createLead(ctx(created.id), S, org.leadInput.parse({ fullName: "SCIM 리드" }))).contactId;
    const patched = await enterprise.scimPatch(S, created.id, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
    expect(patched.active).toBe(false);
    expect(await code(org.getOrg(ctx(created.id), S))).toBe("not_found");
    expect((await one<{ owner_user_id: string }>("SELECT owner_user_id FROM contacts WHERE id=$1", [lead]))!.owner_user_id).toBe(admin.id);
    const re = await enterprise.scimReplace(S, created.id, { userName: "kim@scim-corp.io", active: true, displayName: "김대리" });
    expect(re).toMatchObject({ active: true, displayName: "김대리" });
    await enterprise.scimDelete(S, created.id);
    expect((await enterprise.scimGet(S, created.id)).active).toBe(false);
    expect(await one("SELECT 1 FROM users WHERE id=$1", [created.id])).toBeTruthy(); // personal account is not deleted
  });
});

// ---------------------------------------------------------------------------------------------
describe("F-006 Passkey (WebAuthn)", () => {
  it("registers and signs in with a real ES256 credential; rejects replay, wrong origin and counter regression", async () => {
    const user = await signUp("passkey@pk.io", "패스키");
    const auth = createSoftAuthenticator("https://linkos.test");
    const regOpts = await passkey.registrationOptions(ctx(user.id));
    expect(regOpts.rp.id).toBe("linkos.test");
    const reg = await passkey.verifyRegistration(ctx(user.id), { response: auth.register(regOpts) as any, name: "MacBook" });
    expect(reg.name).toBe("MacBook");
    // the registration challenge is one-time
    await expect(passkey.verifyRegistration(ctx(user.id), { response: auth.register(regOpts) as any })).rejects.toMatchObject({ code: "challenge_expired" });
    expect((await passkey.listPasskeys(user.id)).length).toBe(1);

    // discoverable login (no email)
    const lo = await passkey.authenticationOptions(ctx(null), null);
    const res = await passkey.verifyAuthentication(ctx(null), { challengeId: lo.challengeId, response: auth.login({ challenge: lo.options.challenge, rpId: "linkos.test" }) as any });
    expect(res.userId).toBe(user.id);
    expect((await identity.resolveSession(res.sessionToken, ctx(null)))?.userId).toBe(user.id);
    // replay of the same challenge
    await expect(passkey.verifyAuthentication(ctx(null), { challengeId: lo.challengeId, response: auth.login({ challenge: lo.options.challenge, rpId: "linkos.test" }) as any })).rejects.toMatchObject({ code: "challenge_expired" });
    // email-scoped options list the user's credential
    const lo2 = await passkey.authenticationOptions(ctx(null), "passkey@pk.io");
    expect(lo2.options.allowCredentials?.map((c) => c.id)).toEqual([auth.credentialId]);
    // phishing origin
    await expect(passkey.verifyAuthentication(ctx(null), { challengeId: lo2.challengeId, response: auth.login({ challenge: lo2.options.challenge, rpId: "linkos.test" }, { origin: "https://evil.test" }) as any })).rejects.toMatchObject({ status: 401 });
    // cloned authenticator (counter goes backwards)
    const lo3 = await passkey.authenticationOptions(ctx(null), null);
    await expect(passkey.verifyAuthentication(ctx(null), { challengeId: lo3.challengeId, response: auth.login({ challenge: lo3.options.challenge, rpId: "linkos.test" }, { resetCounter: true }) as any })).rejects.toMatchObject({ status: 401 });
    // unknown credential
    const stranger = createSoftAuthenticator("https://linkos.test");
    stranger.register({ challenge: "x", rp: { id: "linkos.test" }, user: { id: "eA" } });
    const lo4 = await passkey.authenticationOptions(ctx(null), null);
    await expect(passkey.verifyAuthentication(ctx(null), { challengeId: lo4.challengeId, response: stranger.login({ challenge: lo4.options.challenge, rpId: "linkos.test" }) as any })).rejects.toMatchObject({ status: 401 });
    expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='auth.login' AND metadata->>'method'='passkey'", [user.id])).toBeTruthy();
    await passkey.deletePasskey(ctx(user.id), reg.id);
    expect(await passkey.listPasskeys(user.id)).toEqual([]);
  });
});
