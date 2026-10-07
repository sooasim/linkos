// Track D domain logic: F-031 F-032 F-033 F-147 F-149 F-181 F-187 F-188 F-189 F-190 F-191 F-192 F-194 F-195 F-196
import { describe, expect, it } from "vitest";
import {
  PLANS,
  assignVariant,
  checkLimit,
  dunningState,
  effectivePlan,
  estimateCostMicros,
  evaluateFlag,
  eventRoi,
  experimentStats,
  hashBucket,
  inferAudience,
  limitFor,
  livingUpdateDiff,
  rankHighlights,
  revenueMetrics,
  sanitizeProps,
  scoreLead,
  scoreVariants,
  selectVariant,
  suggestUpgrade,
  viralMetrics,
} from "../src/index";

const now = new Date("2026-10-01T00:00:00Z");
const day = 864e5;

describe("F-190/F-191 plans & entitlements", () => {
  it("catalog covers personal and organization plans with limits", () => {
    expect(PLANS.free.scope).toBe("personal");
    expect(PLANS.business.scope).toBe("organization");
    expect(limitFor("free", "exchanges")).toBe(50);
    expect(limitFor("enterprise", "ai_calls")).toBeNull();
    // organization plans are per seat, pooled, with a seat minimum
    expect(limitFor("business", "ocr_scans", 5)).toBe(5000);
    expect(limitFor("business", "ocr_scans", 1)).toBe(3000);
  });

  it("F-192 checkLimit + upgrade suggestion", () => {
    expect(checkLimit("free", "exchanges", 49)).toMatchObject({ allowed: true, remaining: 1 });
    expect(checkLimit("free", "exchanges", 50)).toMatchObject({ allowed: false, limit: 50 });
    expect(checkLimit("business", "exchanges", 1e9).allowed).toBe(true);
    expect(suggestUpgrade("free", "ocr_scans")).toBe("pro");
    expect(suggestUpgrade("pro", "exchanges")).toBe("business");
    expect(suggestUpgrade("enterprise", "ai_calls")).toBeNull();
  });

  it("F-194 dunning: past_due within grace keeps the plan, after grace falls back to Free", () => {
    const grace = { plan: "pro" as const, status: "past_due", graceUntil: new Date(now.getTime() + day) };
    expect(dunningState(grace, now)).toBe("grace");
    expect(effectivePlan([grace], now).plan).toBe("pro");
    const expired = { ...grace, graceUntil: new Date(now.getTime() - day) };
    expect(dunningState(expired, now)).toBe("suspended");
    expect(effectivePlan([expired], now).plan).toBe("free");
    // canceled but paid through period end
    expect(effectivePlan([{ plan: "pro", status: "canceled", currentPeriodEnd: new Date(now.getTime() + day) }], now).plan).toBe("pro");
    // org plan outranks personal
    expect(effectivePlan([{ plan: "pro", status: "active" }, { plan: "business", status: "active", organizationId: "o" }], now).plan).toBe("business");
    expect(effectivePlan([{ plan: "pro", status: "incomplete" }], now).plan).toBe("free");
  });
});

describe("F-195 revenue metrics", () => {
  it("computes MRR/ARR/ARPU/churn with yearly normalization and seats", () => {
    const subs = [
      { status: "active", amountCents: 1200, interval: "month" as const, quantity: 1, createdAt: new Date(now.getTime() - 90 * day), customerKey: "a" },
      { status: "active", amountCents: 2900, interval: "month" as const, quantity: 4, createdAt: new Date(now.getTime() - 90 * day), customerKey: "b" },
      { status: "past_due", amountCents: 12000, interval: "year" as const, quantity: 1, createdAt: new Date(now.getTime() - 5 * day), customerKey: "c" },
      { status: "canceled", amountCents: 1200, interval: "month" as const, quantity: 1, createdAt: new Date(now.getTime() - 90 * day), canceledAt: new Date(now.getTime() - 10 * day), customerKey: "d" },
      { status: "trialing", amountCents: 0, interval: "month" as const, quantity: 1, createdAt: now, customerKey: "e" },
    ];
    const m = revenueMetrics(subs, now);
    expect(m.mrrCents).toBe(1200 + 2900 * 4 + 1000);
    expect(m.arrCents).toBe(m.mrrCents * 12);
    expect(m.payingCustomers).toBe(3);
    expect(m.arpuCents).toBe(Math.round(m.mrrCents / 3));
    expect(m.logoChurnRate).toBeCloseTo(33.3, 1); // 1 of 3 alive at window start
  });
});

describe("F-187 cost estimates", () => {
  it("uses defaults and overrides", () => {
    expect(estimateCostMicros("llm.output_token", 1000)).toBe(25_000);
    expect(estimateCostMicros("ocr.page.on_device", 10)).toBe(0);
    expect(estimateCostMicros("stt.minute", 2, { "stt.minute": 1 })).toBe(2);
    expect(estimateCostMicros("unknown", 5)).toBe(0);
  });
});

describe("F-181 feature flags", () => {
  const base = { key: "new_dock", enabled: true, killed: false, rolloutPercent: 0, allowUsers: [], allowOrgs: [], denyUsers: [] };
  it("kill switch beats every target; deny beats allow", () => {
    expect(evaluateFlag({ ...base, killed: true, allowUsers: ["u1"], rolloutPercent: 100 }, { userId: "u1" })).toEqual({ on: false, reason: "kill_switch" });
    expect(evaluateFlag({ ...base, allowUsers: ["u1"], denyUsers: ["u1"] }, { userId: "u1" }).on).toBe(false);
    expect(evaluateFlag({ ...base, allowUsers: ["u1"] }, { userId: "u1" }).reason).toBe("user_target");
    expect(evaluateFlag({ ...base, allowOrgs: ["o1"] }, { userId: "u9", orgIds: ["o1"] }).reason).toBe("org_target");
    expect(evaluateFlag({ ...base, enabled: false, rolloutPercent: 100 }, { userId: "u1" }).on).toBe(false);
  });
  it("percentage rollout is deterministic and approximately proportional", () => {
    const f = { ...base, rolloutPercent: 25 };
    const ids = Array.from({ length: 4000 }, (_, i) => `user-${i}`);
    const on = ids.filter((id) => evaluateFlag(f, { userId: id }).on).length;
    expect(on / ids.length).toBeGreaterThan(0.22);
    expect(on / ids.length).toBeLessThan(0.28);
    expect(evaluateFlag(f, { userId: "user-7" })).toEqual(evaluateFlag(f, { userId: "user-7" }));
    // monotonic: raising the percentage never turns someone off
    const f50 = { ...base, rolloutPercent: 50 };
    expect(ids.every((id) => !evaluateFlag(f, { userId: id }).on || evaluateFlag(f50, { userId: id }).on)).toBe(true);
  });
  it("hashBucket is stable", () => {
    expect(hashBucket("abc")).toBe(hashBucket("abc"));
    expect(hashBucket("abc")).toBeGreaterThanOrEqual(0);
    expect(hashBucket("abc")).toBeLessThan(10_000);
  });
});

describe("F-196 experiments", () => {
  const exp = { key: "cta", variants: [{ key: "control", weight: 1 }, { key: "bold", weight: 1 }], trafficPercent: 100 };
  it("assigns deterministically with ~even split and respects traffic", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `s${i}`);
    const a = ids.map((id) => assignVariant(exp, id));
    expect(a.every((v) => v === "control" || v === "bold")).toBe(true);
    const bold = a.filter((v) => v === "bold").length / ids.length;
    expect(bold).toBeGreaterThan(0.46);
    expect(bold).toBeLessThan(0.54);
    expect(assignVariant(exp, "s1")).toBe(assignVariant(exp, "s1"));
    const half = ids.map((id) => assignVariant({ ...exp, trafficPercent: 10 }, id)).filter((v) => v !== null).length / ids.length;
    expect(half).toBeGreaterThan(0.07);
    expect(half).toBeLessThan(0.13);
  });
  it("z-test flags a clear winner and not noise", () => {
    const r = experimentStats([{ variant: "control", exposures: 1000, conversions: 100 }, { variant: "bold", exposures: 1000, conversions: 150 }]);
    expect(r[0]!.liftPct).toBeNull();
    expect(r[1]!.liftPct).toBe(50);
    expect(r[1]!.significant).toBe(true);
    const n = experimentStats([{ variant: "control", exposures: 100, conversions: 10 }, { variant: "bold", exposures: 100, conversions: 11 }]);
    expect(n[1]!.significant).toBe(false);
  });
});

describe("F-188 product analytics props", () => {
  it("drops PII keys/values and non-primitives", () => {
    const p = sanitizeProps({ channel: "web_share", latency_ms: 120, email: "a@b.co", note: "x", contact: "kim@acme.com", tel: "010-1234-5678", nested: { a: 1 }, "Bad-Key": 1, ok: true });
    expect(p).toEqual({ channel: "web_share", latency_ms: 120, ok: true });
  });
});

describe("F-189 viral coefficient", () => {
  it("K = new users per sender; second-share rate among claimed", () => {
    const v = viralMetrics({ senders: 10, invitesSent: 40, invitesOpened: 30, replies: 20, claims: 5, claimedWhoShared: 2, sharesByClaimed: 6 });
    expect(v.kFactor).toBe(0.5);
    expect(v.invitesPerSender).toBe(4);
    expect(v.inviteConversion).toBe(0.125);
    expect(v.secondShareRate).toBe(0.4);
    expect(v.claimRate).toBe(0.25);
    expect(viralMetrics({ senders: 0, invitesSent: 0, invitesOpened: 0, replies: 0, claims: 0, claimedWhoShared: 0, sharesByClaimed: 0 }).kFactor).toBeNull();
  });
});

describe("F-031/F-032 audience variants", () => {
  const avail = [
    { audience: "investor", isDefault: false },
    { audience: "customer", isDefault: true },
    { audience: "partner", isDefault: false },
  ];
  it("explicit > event > industry > title > default", () => {
    expect(selectVariant(avail, { explicit: "partner", eventAudience: "investor" })).toEqual({ audience: "partner", reason: "explicit" });
    expect(selectVariant(avail, { explicit: "recruiting", eventAudience: "investor" })).toEqual({ audience: "investor", reason: "event" });
    expect(selectVariant(avail, { recipientIndustry: "벤처캐피탈" })).toEqual({ audience: "investor", reason: "industry" });
    expect(selectVariant(avail, { recipientTitle: "사업개발 이사" })).toEqual({ audience: "partner", reason: "title" });
    expect(selectVariant(avail, { recipientIndustry: "헬스케어", ownerIndustries: ["헬스케어"] })).toEqual({ audience: "partner", reason: "industry" });
    expect(selectVariant(avail, {})).toEqual({ audience: "customer", reason: "default" });
    expect(selectVariant([], { explicit: "investor" })).toEqual({ audience: null, reason: "none" });
  });
  it("adaptive fallback scores variants and reorders highlights without inventing", () => {
    expect(inferAudience("Partner at Blue Capital")).toBe("investor");
    expect(scoreVariants(avail, "시리즈A 투자 검토")[0]!.audience).toBe("investor");
    const h = ["병원 유통망 보유", "의료 영상 AI", "시리즈A 투자 유치"];
    const r = rankHighlights(h, "의료 AI 도입 검토 중인 병원");
    expect(r.sort()).toEqual([...h].sort());
    expect(rankHighlights(h, "의료 AI 도입 검토 중인 병원")[0]).not.toBe("시리즈A 투자 유치");
  });
});

describe("F-033 living update diff", () => {
  it("proposes only non-empty, materially different values", () => {
    const d = livingUpdateDiff({ company: "(주)에이스", jobTitle: "CTO", website: "https://ace.ai/" }, { company: "에이스", jobTitle: "VP Engineering", website: "ace.ai" });
    expect(d).toEqual([{ field: "jobTitle", from: "VP Engineering", to: "CTO" }]);
    expect(livingUpdateDiff({ company: "", jobTitle: null }, { company: "X" })).toEqual([]);
  });
});

describe("F-147/F-149 booth leads & ROI", () => {
  it("scores BANT leads", () => {
    expect(scoreLead({ qualifiers: ["budget", "authority", "need", "timeline"], hasEmail: true, hasPhone: false, hasNotes: false, interest: "hot" })).toEqual({ score: 92, grade: "A" });
    expect(scoreLead({ qualifiers: ["need", "budget", "bogus"], hasEmail: true, hasPhone: false, hasNotes: true }).grade).toBe("B");
    expect(scoreLead({ qualifiers: [], hasEmail: false, hasPhone: false, hasNotes: false }).grade).toBe("C");
  });
  it("computes cost per lead and ROI", () => {
    const r = eventRoi({ leads: 20, qualifiedLeads: 5, meetingsBooked: 4, followupsTotal: 10, followupsDone: 7, costCents: 100_000, pipelineCents: 500_000, wonCents: 250_000 });
    expect(r.costPerLeadCents).toBe(5000);
    expect(r.costPerQualifiedLeadCents).toBe(20_000);
    expect(r.followupCompletion).toBe(70);
    expect(r.roiPct).toBe(150);
    expect(eventRoi({ leads: 0, qualifiedLeads: 0, meetingsBooked: 0, followupsTotal: 0, followupsDone: 0, costCents: 0, pipelineCents: 0, wonCents: 0 }).costPerLeadCents).toBeNull();
  });
});
