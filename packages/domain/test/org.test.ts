import { describe, expect, it } from "vitest";
import {
  ORG_ROLES,
  PERMISSIONS,
  type OrgRole,
  type Permission,
  attributable,
  averageGapDays,
  can,
  canAssignRole,
  canInviteAs,
  computeStrength,
  contrastText,
  coolingRisk,
  detectOpportunities,
  domainJoinDecision,
  emailDomain,
  exportAllowed,
  extractNeedStatements,
  forceLayout,
  hasApiScope,
  introCandidates,
  introStats,
  isClaimableDomain,
  mergePolicies,
  parseApiKey,
  profilePolicyViolations,
  rankWhoKnows,
  retentionCutoff,
  rewardDecision,
  validateBranding,
  validateRetention,
  verifyDomainClaim,
  wouldOrphanOrg,
} from "../src/index";

// F-130: explicit expected matrix for every role × permission (no implicit grants)
const EXPECTED: Record<OrgRole, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== "org.delete"),
  manager: ["org.read", "members.read", "members.invite", "members.approve", "contacts.read", "contacts.read_pii", "contacts.share", "contacts.write", "leads.assign", "notes.read", "notes.write", "graph.read", "dashboard.read", "export.org"],
  member: ["org.read", "members.read", "contacts.read", "contacts.read_pii", "contacts.share", "contacts.write", "notes.read", "notes.write", "graph.read"],
  viewer: ["org.read", "members.read", "contacts.read", "notes.read"],
};

describe("F-130 역할 권한 RBAC", () => {
  for (const role of ORG_ROLES) {
    it(`${role}: permission matrix`, () => {
      for (const p of PERMISSIONS) expect([role, p, can(role, p)]).toEqual([role, p, EXPECTED[role].includes(p)]);
    });
  }
  it("denies everything without a role", () => {
    expect(PERMISSIONS.some((p) => can(null, p))).toBe(false);
  });
  it("role assignment rules", () => {
    expect(canAssignRole("owner", "member", "owner")).toBe(true);
    expect(canAssignRole("admin", "member", "manager")).toBe(true);
    expect(canAssignRole("admin", "member", "admin")).toBe(false);
    expect(canAssignRole("admin", "admin", "member")).toBe(false);
    expect(canAssignRole("admin", "owner", "member")).toBe(false);
    expect(canAssignRole("manager", "viewer", "member")).toBe(false);
    expect(canAssignRole("member", "viewer", "member")).toBe(false);
    expect(canAssignRole("viewer", "viewer", "viewer")).toBe(false);
    expect(canInviteAs("manager", "member")).toBe(true);
    expect(canInviteAs("manager", "manager")).toBe(false);
    expect(canInviteAs("admin", "manager")).toBe(true);
    expect(canInviteAs("admin", "owner")).toBe(false);
    expect(canInviteAs("member", "viewer")).toBe(false);
    expect(wouldOrphanOrg(1, "owner", "admin")).toBe(true);
    expect(wouldOrphanOrg(2, "owner", null)).toBe(false);
  });
});

describe("F-004 domain join", () => {
  it("only claims the admin's own non-webmail domain", () => {
    expect(emailDomain("Kim@Acme.co.kr")).toBe("acme.co.kr");
    expect(verifyDomainClaim("kim@acme.co.kr", "acme.co.kr")).toBe("acme.co.kr");
    expect(verifyDomainClaim("kim@acme.co.kr", "other.com")).toBeNull();
    expect(verifyDomainClaim("kim@gmail.com", "gmail.com")).toBeNull();
    expect(isClaimableDomain("naver.com")).toBe(false);
  });
  it("decides join/request/none by mode", () => {
    expect(domainJoinDecision("a@acme.io", ["acme.io"], "auto")).toBe("join");
    expect(domainJoinDecision("a@acme.io", ["acme.io"], "approval")).toBe("request");
    expect(domainJoinDecision("a@acme.io", ["acme.io"], "off")).toBe("none");
    expect(domainJoinDecision("a@evil.io", ["acme.io"], "auto")).toBe("none");
  });
});

describe("F-139 정책 강제 / F-136 retention / F-138 branding / F-140 api keys", () => {
  it("merges policies to the strictest", () => {
    const p = mergePolicies([{ minFieldVisibility: "business", blockExportRoles: ["viewer"] }, { minFieldVisibility: "trusted", blockExportRoles: ["member"], requireAllPartyRecordingConsent: true }]);
    expect(p).toMatchObject({ minFieldVisibility: "trusted", requireAllPartyRecordingConsent: true });
    expect(p.blockExportRoles!.sort()).toEqual(["member", "viewer"]);
    expect(exportAllowed(["member"], p)).toBe(false);
    expect(exportAllowed(["admin"], p)).toBe(true);
  });
  it("flags card fields that are too public or missing", () => {
    const v = profilePolicyViolations([{ type: "phone", visibility: "public", value: "010" }, { type: "website", visibility: "public", value: "x" }], { minFieldVisibility: "business", requiredCardFields: ["email"] });
    expect(v.map((x) => x.code)).toEqual(["field_too_public", "required_field_missing"]);
  });
  it("validates retention bounds", () => {
    expect(validateRetention({ inactiveContactDays: 10 })).toHaveLength(1);
    expect(validateRetention({ auditLogDays: 100 })).toHaveLength(1);
    expect(validateRetention({ inactiveContactDays: 365, teamNoteDays: 90, auditLogDays: 400 })).toEqual([]);
    expect(retentionCutoff(30, new Date("2026-02-01T00:00:00Z"))!.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(retentionCutoff(null)).toBeNull();
  });
  it("validates branding and picks AA text color", () => {
    expect(validateBranding({ primaryColor: "red", logoUrl: "javascript:alert(1)" })).toHaveLength(2);
    expect(validateBranding({ primaryColor: "#C8F03C", logoUrl: "https://cdn.acme.io/logo.svg" })).toEqual([]);
    expect(contrastText("#C8F03C")).toBe("#0E0E10");
    expect(contrastText("#0E0E10")).toBe("#F4F1EA");
  });
  it("parses api keys and scopes", () => {
    const k = `lk_Ab12Cd34_${"x".repeat(40)}`;
    expect(parseApiKey(`Bearer ${k}`)).toEqual({ prefix: "Ab12Cd34", key: k });
    expect(parseApiKey("lk_short_x")).toBeNull();
    expect(hasApiScope(["leads:write"], "leads:read")).toBe(true);
    expect(hasApiScope(["contacts:read"], "leads:read")).toBe(false);
  });
});

describe("F-074 관계 강도 / F-098 미접촉 위험", () => {
  it("scores recency, frequency, meetings with explanations", () => {
    const strong = computeStrength({ daysSinceLastContact: 3, encounters90d: 4, encountersTotal: 10, meetingsTotal: 3, notesTotal: 3, followupsDone: 2, reciprocal: true });
    const weak = computeStrength({ daysSinceLastContact: 200, encounters90d: 0, encountersTotal: 1, meetingsTotal: 0, notesTotal: 0, followupsDone: 0, reciprocal: false });
    expect(strong.score).toBeGreaterThan(0.9);
    expect(strong.band).toBe("strong");
    expect(weak.band).toBe("weak");
    expect(strong.factors.map((f) => f.kind).sort()).toEqual(["followups", "frequency", "meetings", "notes", "recency", "reciprocal"]);
    expect(strong.factors[0]!.contribution).toBeGreaterThanOrEqual(strong.factors[5]!.contribution);
  });
  it("detects cooling relationships against their cadence", () => {
    expect(coolingRisk({ strength: 0.6, daysSinceLastContact: 100, avgGapDays: 14, meetingsTotal: 0, vip: false })).toMatchObject({ atRisk: true, level: "high", thresholdDays: 30 });
    expect(coolingRisk({ strength: 0.6, daysSinceLastContact: 20, avgGapDays: 14, meetingsTotal: 0, vip: false }).atRisk).toBe(false);
    expect(coolingRisk({ strength: 0.1, daysSinceLastContact: 300, avgGapDays: null, meetingsTotal: 0, vip: false }).atRisk).toBe(false);
    expect(coolingRisk({ strength: 0.1, daysSinceLastContact: 60, avgGapDays: null, meetingsTotal: 0, vip: true })).toMatchObject({ atRisk: true, level: "medium" });
    expect(averageGapDays([new Date("2026-01-01"), new Date("2026-01-11"), new Date("2026-01-31")])).toBe(15);
  });
});

describe("F-134 / F-152 / F-099 / F-133 graph", () => {
  it("ranks who-knows-whom and hides personal contact names", () => {
    const r = rankWhoKnows([
      { memberId: "m1", memberName: "A", contactId: "c1", contactName: "Kim", jobTitle: "CTO", strength: 0.9, shared: true },
      { memberId: "m2", memberName: "B", contactId: "c2", contactName: "Lee", jobTitle: "PM", strength: 0.4, shared: false },
      { memberId: "m2", memberName: "B", contactId: "c3", contactName: "Park", jobTitle: null, strength: 0.3, shared: false },
    ]);
    expect(r[0]!.memberId).toBe("m1");
    expect(r[1]!.contacts.every((c) => c.name === null && c.contactId === null)).toBe(true);
    expect(r[1]!.reasons.join(" ")).toContain("비공개");
  });
  it("finds intro candidates from Need↔Offer with explainable reasons", () => {
    const c = introCandidates([
      { id: "a", name: "A", company: "X", offers: [], needs: ["의료 AI 영상 판독 파트너"], industries: ["헬스케어"], strength: 0.8, via: "나" },
      { id: "b", name: "B", company: "Y", offers: ["의료 AI 영상 판독 솔루션"], needs: [], industries: ["헬스케어"], strength: 0.6, via: "나" },
      { id: "c", name: "C", company: "Z", offers: ["물류 창고"], needs: [], industries: [], strength: 0.9, via: "나" },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ partyA: { id: "a" }, partyB: { id: "b" }, provenance: "ai_inferred" });
    expect(c[0]!.reasons[0]).toContain("Need");
    expect(c[0]!.path).toEqual(["A", "나", "B"]);
  });
  it("extracts only literal need statements and matches offers", () => {
    expect(extractNeedStatements("오늘 미팅 좋았음.\n- 물류 자동화 파트너가 필요합니다\n다음 주 연락")).toEqual(["물류 자동화 파트너가 필요합니다"]);
    const o = detectOpportunities(
      [{ text: "물류 자동화 파트너가 필요합니다", source: "note", sourceId: "n1", personId: "p1", personName: "Kim" }],
      [{ text: "물류 자동화 로봇", personId: "p2", personName: "Lee", kind: "contact" }, { text: "회계 자문", personId: "p3", personName: "Park", kind: "contact" }],
    );
    expect(o).toHaveLength(1);
    expect(o[0]!.offer.personId).toBe("p2");
    expect(o[0]!.provenance).toBe("ai_inferred");
  });
  it("lays out a graph deterministically within bounds", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const edges = nodes.slice(1).map((n) => ({ source: "n0", target: n.id }));
    const a = forceLayout(nodes, edges, { width: 400, height: 300, seed: 7 });
    const b = forceLayout(nodes, edges, { width: 400, height: 300, seed: 7 });
    expect(a).toEqual(b);
    for (const p of Object.values(a)) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(380);
      expect(p.y).toBeLessThanOrEqual(280);
    }
    // hub ends up nearer to the center than the average leaf
    const d = (p: { x: number; y: number }) => Math.hypot(p.x - 200, p.y - 150);
    const leafAvg = nodes.slice(1).reduce((s, n) => s + d(a[n.id]!), 0) / 11;
    expect(d(a.n0!)).toBeLessThan(leafAvg);
  });
});

describe("F-064 / F-197 / F-159", () => {
  it("attributes only new accounts within the window", () => {
    const t = new Date("2026-03-01T00:00:00Z");
    expect(attributable({ referrerId: "a", referredId: "b", referredCreatedAt: new Date("2026-03-02T00:00:00Z"), touchpointAt: t, alreadyAttributed: false }).ok).toBe(true);
    expect(attributable({ referrerId: "a", referredId: "b", referredCreatedAt: new Date("2026-02-01T00:00:00Z"), touchpointAt: t, alreadyAttributed: false }).reason).toBe("existing_user");
    expect(attributable({ referrerId: "a", referredId: "a", referredCreatedAt: t, touchpointAt: t, alreadyAttributed: false }).reason).toBe("self");
    expect(attributable({ referrerId: "a", referredId: "b", referredCreatedAt: t, touchpointAt: t, alreadyAttributed: true }).reason).toBe("already_attributed");
  });
  it("grants rewards only after activation and under the cap", () => {
    expect(rewardDecision({ referredActivated: false, grantedThisMonth: 0 })).toBe("wait");
    expect(rewardDecision({ referredActivated: true, grantedThisMonth: 0 })).toBe("grant");
    expect(rewardDecision({ referredActivated: true, grantedThisMonth: 20 })).toBe("cap");
  });
  it("computes intro conversion funnel", () => {
    const s = introStats([
      { state: "WON", outcome: "won" },
      { state: "ROOM_CREATED", outcome: "meeting" },
      { state: "DECLINED", outcome: "none" },
      { state: "INTRO_PROPOSED", outcome: "none" },
    ]);
    expect(s).toMatchObject({ total: 4, accepted: 2, meetings: 2, opportunities: 1, won: 1, declined: 1, acceptRate: 50, winRate: 25 });
  });
});
