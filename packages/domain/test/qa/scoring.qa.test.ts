// QA (generated): F-074 relationship strength · F-098 cooling risk · F-097 match scoring · F-020/F-021 duplicates & merge.
// Properties: bounds, monotonicity, symmetry, explainability, "never invent data" in merges.
import { describe, expect, it } from "vitest";
import {
  type ContactLike,
  MERGEABLE_FIELDS,
  type MatchProfile,
  type StrengthSignals,
  averageGapDays,
  computeStrength,
  coolingRisk,
  diffContacts,
  findDuplicates,
  mergeContacts,
  rankMatches,
  scoreDuplicate,
  scoreMatch,
  similarity,
  textSimilarity,
} from "../../src";
import { type Rng, cases } from "./_gen";

function signals(r: Rng): StrengthSignals {
  return {
    daysSinceLastContact: r.bool(0.1) ? null : r.int(0, 800) + r.next(),
    encounters90d: r.int(0, 12),
    encountersTotal: r.int(0, 40),
    meetingsTotal: r.int(0, 8),
    notesTotal: r.int(0, 8),
    followupsDone: r.int(0, 5),
    reciprocal: r.bool(),
  };
}

const STRENGTH = cases(600, 1111, signals);

describe("QA · computeStrength (600 generated signal vectors)", () => {
  it.each(STRENGTH)("signals #$i: bounded, monotone, explained", ({ c }) => {
    const s = computeStrength(c);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.band).toBe(s.score >= 0.55 ? "strong" : s.score >= 0.3 ? "medium" : "weak");
    expect(s.factors).toHaveLength(6);
    for (let k = 1; k < s.factors.length; k++) expect(s.factors[k - 1]!.contribution).toBeGreaterThanOrEqual(s.factors[k]!.contribution);
    // more of any positive signal never lowers the score
    const bumps: Partial<StrengthSignals>[] = [
      { encounters90d: c.encounters90d + 1 }, { encountersTotal: c.encountersTotal + 3 }, { meetingsTotal: c.meetingsTotal + 1 },
      { notesTotal: c.notesTotal + 1 }, { followupsDone: c.followupsDone + 1 }, { reciprocal: true },
      { daysSinceLastContact: c.daysSinceLastContact == null ? 0 : Math.max(0, c.daysSinceLastContact - 10) },
    ];
    for (const b of bumps) expect(computeStrength({ ...c, ...b }).score).toBeGreaterThanOrEqual(s.score);
    // longer silence never raises it
    if (c.daysSinceLastContact != null) expect(computeStrength({ ...c, daysSinceLastContact: c.daysSinceLastContact + 30 }).score).toBeLessThanOrEqual(s.score);
  });

  it.each(cases(200, 1112, (r) => ({ strength: r.next(), daysSinceLastContact: r.bool(0.1) ? null : r.int(0, 400), avgGapDays: r.bool(0.3) ? null : r.int(1, 120), meetingsTotal: r.int(0, 3), vip: r.bool(0.2) })))(
    "cooling #$i: risk only for important relationships past the threshold",
    ({ c }) => {
      const res = coolingRisk(c);
      expect(res.thresholdDays).toBeGreaterThanOrEqual(30);
      expect(res.thresholdDays).toBeLessThanOrEqual(120);
      const important = c.vip || c.strength >= 0.45 || c.meetingsTotal >= 1;
      expect(res.atRisk).toBe(important && c.daysSinceLastContact != null && c.daysSinceLastContact > res.thresholdDays);
      if (res.atRisk) expect(res.reasons.length).toBeGreaterThan(0);
      if (res.atRisk && c.daysSinceLastContact! > res.thresholdDays * 2) expect(res.level).toBe("high");
    },
  );

  it.each(cases(100, 1113, (r) => Array.from({ length: r.int(0, 10) }, () => new Date(Date.UTC(2026, 0, 1) + r.int(0, 365) * 864e5))))("averageGapDays #$i", ({ c }) => {
    const g = averageGapDays(c);
    if (c.length < 2) expect(g).toBeNull();
    else {
      const t = c.map((d) => d.getTime());
      expect(g).toBeCloseTo((Math.max(...t) - Math.min(...t)) / (c.length - 1) / 864e5, 6);
    }
  });
});

const TOPICS = ["의료 AI 영상판독", "병원 유통 파트너", "시리즈A 투자", "B2B SaaS 영업", "cloud security audit", "AI product design", "hiring backend engineers", "医療機器 販売", "跨境电商 物流", "seed investment", "마케팅 대행", "로봇 자동화"];

function profile(r: Rng, id: string): MatchProfile {
  return {
    id,
    name: `P${id}`,
    offers: r.subset(TOPICS).slice(0, 3),
    needs: r.subset(TOPICS).slice(0, 3),
    industries: r.subset(["healthcare", "fintech", "saas", "robotics"]),
    regions: r.subset(["seoul", "busan", "tokyo"]),
    projects: r.subset(TOPICS).slice(0, 1),
    trust: r.bool(0.3) ? r.next() * 1.4 - 0.2 : undefined,
    matchingOptOut: r.bool(0.05),
  };
}

const MATCHES = cases(500, 1214, (r) => ({ a: profile(r, "a"), b: profile(r, "b") }));

describe("QA · scoreMatch (500 generated profile pairs)", () => {
  it.each(MATCHES)("pair #$i: bounded, explainable, labelled ai_inferred", ({ c }) => {
    const m = scoreMatch(c.a, c.b);
    if (c.b.matchingOptOut) expect(m).toBeNull();
    if (!m) return;
    expect(m.score).toBeGreaterThanOrEqual(0);
    expect(m.score).toBeLessThanOrEqual(1);
    expect(m.provenance).toBe("ai_inferred");
    expect(m.reasons.length).toBeLessThanOrEqual(4);
    // adding a shared industry / trust never lowers the score
    const more = scoreMatch(c.a, { ...c.b, industries: [...(c.b.industries ?? []), ...(c.a.industries ?? ["x"])], trust: Math.max(c.b.trust ?? 0, 0.9) });
    expect(more!.score).toBeGreaterThanOrEqual(m.score);
  });

  it("self and opted-out profiles never match", () => {
    const p: MatchProfile = { id: "x", name: "x", offers: ["시리즈A 투자"], needs: ["시리즈A 투자"] };
    expect(scoreMatch(p, p)).toBeNull();
    expect(scoreMatch(p, { ...p, id: "y", matchingOptOut: true })).toBeNull();
  });

  it.each(cases(50, 1215, (r) => ({ me: profile(r, "me"), pool: Array.from({ length: r.int(0, 40) }, (_, k) => profile(r, `c${k}`)), limit: r.int(1, 25) })))("rankMatches #$i sorted & limited", ({ c }) => {
    const ranked = rankMatches(c.me, c.pool, c.limit);
    expect(ranked.length).toBeLessThanOrEqual(c.limit);
    for (let k = 1; k < ranked.length; k++) expect(ranked[k - 1]!.score).toBeGreaterThanOrEqual(ranked[k]!.score);
    for (const m of ranked) expect(m.score).toBeGreaterThanOrEqual(0.12);
  });

  it.each(cases(200, 1216, (r) => [r.pick(TOPICS), r.pick(TOPICS)] as const))("textSimilarity #$i symmetric & bounded", ({ c: [a, b] }) => {
    const s = textSimilarity(a, b);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1 + 1e-12);
    expect(textSimilarity(b, a)).toBeCloseTo(s, 12);
    expect(textSimilarity(a, a)).toBeCloseTo(a.trim() ? 1 : 0, 12);
  });
});

function contact(r: Rng, id: string): ContactLike & { id: string } {
  const n = r.pick(["김민수", "김 민 수", "Minsu Kim", "kim minsu", "박영희", "이도윤", "Jane Doe", "jane  doe", "J. Doe"]);
  return {
    id,
    fullName: n,
    company: r.pick([null, "(주)에이스테크", "에이스테크 주식회사", "Ace Tech Inc.", "Globex", ""]),
    email: r.pick([null, "ms@ace.io", "MS@ACE.IO", " ms@ace.io ", "jane@globex.com", "not-an-email"]),
    phone: r.pick([null, "010-1234-5678", "+82 10-1234-5678", "+82 010 1234 5678", "01012345678", "02-555-1234"]),
    jobTitle: r.pick([null, "CTO", "팀장"]),
    address: r.bool(0.2) ? "서울" : null,
  };
}

const PAIRS = cases(800, 1317, (r) => ({ a: contact(r, "a"), b: contact(r, "b") }));

describe("QA · duplicate detection & merge (800 generated contact pairs)", () => {
  it.each(PAIRS)("pair #$i: symmetric, bounded, merge never loses or invents data", ({ c }) => {
    const ab = scoreDuplicate(c.a, c.b);
    const ba = scoreDuplicate(c.b, c.a);
    expect(ab.score).toBeCloseTo(ba.score, 12);
    expect([...ab.reasons].sort()).toEqual([...ba.reasons].sort());
    expect(ab.score).toBeGreaterThanOrEqual(0);
    expect(ab.score).toBeLessThanOrEqual(1);
    if (!ab.reasons.includes("email_exact") && !ab.reasons.includes("phone_exact")) expect(ab.score).toBeLessThanOrEqual(0.9); // fuzzy never auto-merges
    expect(similarity(c.a.fullName, c.b.fullName)).toBeCloseTo(similarity(c.b.fullName, c.a.fullName), 12);
    const merged = mergeContacts(c.a, c.b);
    for (const f of MERGEABLE_FIELDS) {
      const v = merged[f];
      if (v) expect([c.a[f], c.b[f]]).toContain(v); // nothing invented
      if (c.a[f]) expect(v).toBe(c.a[f]); // primary wins by default
      else if (c.b[f]) expect(v).toBe(c.b[f]); // gaps are filled
    }
    const chosen = mergeContacts(c.a, c.b, Object.fromEntries(MERGEABLE_FIELDS.map((f) => [f, "secondary"])));
    for (const f of MERGEABLE_FIELDS) expect(chosen[f]).toBe(c.b[f] ? c.b[f] : c.a[f]);
    const diff = diffContacts(c.a, c.b);
    expect(diff.map((d) => d.field)).toEqual([...MERGEABLE_FIELDS]);
    const dups = findDuplicates(c.a, [c.b, c.a]);
    expect(dups.every((d) => d.contact.id !== c.a.id)).toBe(true); // never a duplicate of itself
  });
});
