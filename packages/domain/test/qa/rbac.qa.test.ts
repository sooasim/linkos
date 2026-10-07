// QA (generated): F-129/F-130 org RBAC matrix · F-004 domain join · F-139 policies · F-008 SSO enforcement ·
// F-140 API keys · F-190~F-194 plans, limits, dunning.
import { describe, expect, it } from "vitest";
import {
  METRICS,
  ORG_ROLES,
  type OrgPolicies,
  type OrgRole,
  PERMISSIONS,
  PLAN_IDS,
  PLANS,
  type PlanId,
  SUBSCRIPTION_STATUSES,
  can,
  canAssignRole,
  canInviteAs,
  checkLimit,
  domainJoinDecision,
  dunningState,
  effectivePlan,
  emailDomain,
  exportAllowed,
  hasApiScope,
  isClaimableDomain,
  isEntitled,
  limitFor,
  mergePolicies,
  parseApiKey,
  permissionsOf,
  profilePolicyViolations,
  ssoEnforcementDecision,
  suggestUpgrade,
  validateRetention,
  verifyDomainClaim,
  wouldOrphanOrg,
} from "../../src";
import { cases, product } from "./_gen";

const RANK: Record<OrgRole, number> = { viewer: 0, member: 1, manager: 2, admin: 3, owner: 4 };
const ADMIN_ONLY = ["org.update", "policy.manage", "retention.manage", "sso.manage", "apikeys.manage", "audit.read", "members.role", "members.remove"];

describe(`QA · RBAC matrix (${ORG_ROLES.length} roles × ${PERMISSIONS.length} permissions)`, () => {
  it.each(product({ role: ORG_ROLES, perm: PERMISSIONS }))("$role / $perm", ({ role, perm }) => {
    const ok = can(role, perm);
    // monotone: a higher role has every permission of a lower role
    for (const other of ORG_ROLES) if (RANK[other] >= RANK[role] && ok) expect(can(other, perm)).toBe(true);
    if (role === "owner") expect(ok).toBe(true);
    if (perm === "org.delete") expect(ok).toBe(role === "owner");
    if (ADMIN_ONLY.includes(perm)) expect(ok).toBe(RANK[role] >= RANK.admin);
    if (role === "viewer") expect(ok).toBe(perm.endsWith(".read") && perm !== "audit.read" && perm !== "graph.read" && perm !== "dashboard.read");
    if (perm === "contacts.read_pii") expect(ok).toBe(RANK[role] >= RANK.member); // viewers never see team PII
    expect(permissionsOf(role).includes(perm)).toBe(ok);
  });
  it.each([null, undefined])("no role → no permission (%s)", (r) => {
    for (const p of PERMISSIONS) expect(can(r, p)).toBe(false);
  });

  it.each(product({ actor: ORG_ROLES, target: [null, ...ORG_ROLES], next: ORG_ROLES }))("assign: $actor sets $target → $next", ({ actor, target, next }) => {
    const ok = canAssignRole(actor, target, next);
    if (actor !== "owner" && next === "owner") expect(ok).toBe(false); // only owners mint owners
    if (actor !== "owner" && target && RANK[target] >= RANK.admin) expect(ok).toBe(false); // admins can't touch admins/owners
    if (RANK[actor] < RANK.admin) expect(ok).toBe(false);
    if (actor === "admin" && (!target || RANK[target] < RANK.admin) && RANK[next] < RANK.admin) expect(ok).toBe(true);
    if (actor === "owner") expect(ok).toBe(true);
  });

  it.each(product({ actor: ORG_ROLES, role: ORG_ROLES }))("invite: $actor invites as $role", ({ actor, role }) => {
    const ok = canInviteAs(actor, role);
    if (RANK[actor] < RANK.manager) expect(ok).toBe(false);
    if (ok) expect(RANK[role] <= RANK[actor]).toBe(true); // never invite above yourself
    if (actor === "manager") expect(ok).toBe(RANK[role] < RANK.manager);
  });

  it.each(product({ owners: [0, 1, 2, 5], current: ORG_ROLES, next: [null, ...ORG_ROLES] }))("orphan check owners=$owners $current→$next", ({ owners, current, next }) => {
    expect(wouldOrphanOrg(owners, current, next)).toBe(current === "owner" && next !== "owner" && owners <= 1);
  });
});

const EMAILS = ["kim@acme.com", "KIM@ACME.COM", "kim@acme.com.", " kim@acme.com", "kim@acme.com ", "kim@sub.acme.com", "kim@acme.co", "kim@gmail.com", "kim@acme.com@evil.io", "no-at-sign", "", "@acme.com"];

describe("QA · SSO enforcement & domain join (F-004/F-008)", () => {
  it.each(product({ email: EMAILS, method: ["email_otp", "google", "passkey", "oidc_sso", "saml_sso"] as const, role: [null, "member", "owner"] as const, ssoRequired: [false, true], ssoAvailable: [false, true] }))(
    "$email via $method ($role, required=$ssoRequired, available=$ssoAvailable)",
    ({ email, method, role, ssoRequired, ssoAvailable }) => {
      const d = ssoEnforcementDecision({ ssoRequired, ssoAvailable, email, verifiedDomains: ["acme.com"], role, method });
      // the org domain is decided exactly like domain-join does (emailDomain), so "kim@acme.com." / "KIM@ACME.COM" cannot bypass the IdP
      const onDomain = emailDomain(email) === "acme.com";
      const expected = !ssoRequired || !ssoAvailable || method === "oidc_sso" || method === "saml_sso" || !onDomain || (role === "owner" && method === "email_otp") ? "allow" : "sso_required";
      expect(d).toBe(expected);
    },
  );
  it.each(product({ email: EMAILS, mode: ["off", "auto", "approval"] as const }))("domain join $email ($mode)", ({ email, mode }) => {
    const d = domainJoinDecision(email, ["acme.com"], mode);
    const onDomain = emailDomain(email) === "acme.com";
    expect(d).toBe(!onDomain || mode === "off" ? "none" : mode === "auto" ? "join" : "request");
  });
  it.each(product({ admin: ["boss@acme.com", "boss@gmail.com", "boss@evil.io", null], domain: ["acme.com", "https://acme.com/", "@ACME.com", "gmail.com", "evil.io", "acme"] }))("domain claim $admin → $domain", ({ admin, domain }) => {
    const v = verifyDomainClaim(admin, domain);
    if (v) {
      expect(isClaimableDomain(v)).toBe(true);
      expect(emailDomain(admin)).toBe(v); // only a verified mailbox on that domain proves ownership
    }
    if (domain.includes("gmail")) expect(v).toBeNull();
  });
});

describe("QA · policies, retention, API keys", () => {
  const POL = cases(200, 2128, (r) => Array.from({ length: r.int(0, 4) }, (): OrgPolicies => ({
    requireAllPartyRecordingConsent: r.bool(0.3) || undefined,
    blockExportRoles: r.subset(ORG_ROLES),
    minFieldVisibility: r.pick([undefined, "public", "business", "trusted"] as const),
    requiredCardFields: r.subset(["email", "phone", "company"]),
    graphPersonalExposure: r.pick([undefined, "company_level", "shared_only"] as const),
  })));
  it.each(POL)("mergePolicies #$i is the strictest combination", ({ c }) => {
    const m = mergePolicies(c);
    const rank = { public: 0, business: 1, trusted: 2 } as const;
    for (const p of c) {
      if (p.requireAllPartyRecordingConsent) expect(m.requireAllPartyRecordingConsent).toBe(true);
      for (const r of p.blockExportRoles ?? []) expect(m.blockExportRoles).toContain(r);
      if (p.minFieldVisibility) expect(rank[m.minFieldVisibility!]).toBeGreaterThanOrEqual(rank[p.minFieldVisibility]);
      for (const f of p.requiredCardFields ?? []) expect(m.requiredCardFields).toContain(f);
      if (p.graphPersonalExposure === "shared_only") expect(m.graphPersonalExposure).toBe("shared_only");
      for (const role of ORG_ROLES) if (!exportAllowed([role], p)) expect(exportAllowed([role], m)).toBe(false);
    }
    const viol = profilePolicyViolations([{ type: "email", visibility: "public", value: "a@b.io" }], m);
    if (m.minFieldVisibility && m.minFieldVisibility !== "public") expect(viol.some((v) => v.code === "field_too_public")).toBe(true);
  });
  it.each([
    [{ inactiveContactDays: 29 }, 1], [{ inactiveContactDays: 30 }, 0], [{ auditLogDays: 364 }, 1], [{ auditLogDays: 365 }, 0], [{ teamNoteDays: 3651 }, 1], [{ teamNoteDays: 1.5 }, 1], [{ teamNoteDays: null }, 0], [{ inactiveContactDays: Number.NaN }, 1],
  ])("validateRetention(%o) → %i errors", (p, n) => expect(validateRetention(p)).toHaveLength(n));
  it.each([
    ["lk_abcdefgh_" + "x".repeat(32), true], ["Bearer lk_abcdefgh_" + "x".repeat(40), true], ["lk_abc_" + "x".repeat(32), false], ["lk_abcdefgh_short", false], ["lk_abcdefgh_" + "x".repeat(65), false], ["", false], [null, false], ["lk_abcdefgh_" + "x".repeat(32) + "\n", true],
  ])("parseApiKey(%j)", (raw, ok) => expect(parseApiKey(raw as string | null) !== null).toBe(ok));
  it.each(product({ have: [[], ["contacts:read"], ["leads:write"], ["leads:read"], ["leads:read", "leads:write"]], need: ["contacts:read", "leads:read", "leads:write"] as const }))("scope $have ⊢ $need", ({ have, need }) => {
    const ok = hasApiScope(have, need);
    expect(ok).toBe(have.includes(need) || (need === "leads:read" && have.includes("leads:write")));
  });
});

describe(`QA · plans & limits (${PLAN_IDS.length} plans × ${METRICS.length} metrics × seats)`, () => {
  const SEATS = [0, 1, 2, 3, 10, 499, 500, 600];
  it.each(product({ plan: PLAN_IDS, metric: METRICS, seats: SEATS }))("$plan/$metric seats=$seats", ({ plan, metric, seats }) => {
    const l = limitFor(plan, metric, seats);
    const base = PLANS[plan].limits[metric];
    if (base === null) expect(l).toBeNull();
    else {
      expect(l).toBeGreaterThanOrEqual(base); // never below the plan's base
      expect(limitFor(plan, metric, seats + 1)).toBeGreaterThanOrEqual(l!); // monotone in seats
      for (const used of [0, l! - 1, l!, l! + 1]) {
        const c = checkLimit(plan, metric, used, 1, seats);
        expect(c.allowed).toBe(used + 1 <= l!);
        expect(c.remaining).toBe(Math.max(0, l! - used));
      }
    }
    const up = suggestUpgrade(plan, metric);
    if (up) {
      expect(PLAN_IDS.indexOf(up)).toBeGreaterThan(PLAN_IDS.indexOf(plan));
      const ul = PLANS[up].limits[metric];
      expect(ul === null || base === null || ul > base).toBe(true);
    }
  });
  const now = new Date("2026-10-07T00:00:00Z");
  it.each(product({ status: [...SUBSCRIPTION_STATUSES, "weird"], grace: [null, -1, 1], periodEnd: [null, -1, 1] }))("entitlement $status grace=$grace end=$periodEnd", ({ status, grace, periodEnd }) => {
    const sub = { plan: "pro" as PlanId, status, graceUntil: grace == null ? null : new Date(now.getTime() + grace * 864e5), currentPeriodEnd: periodEnd == null ? null : new Date(now.getTime() + periodEnd * 864e5) };
    const d = dunningState(sub, now);
    if (status === "active" || status === "trialing") expect(d).toBe("ok");
    else if (status === "past_due") expect(d).toBe(grace === 1 ? "grace" : "suspended");
    else expect(d).toBe("suspended");
    const ent = isEntitled(sub, now);
    expect(ent).toBe(d !== "suspended" || (status === "canceled" && periodEnd === 1));
    const eff = effectivePlan([sub, { plan: "free", status: "active" }], now);
    expect(eff.plan).toBe(ent ? "pro" : "free");
  });
});
