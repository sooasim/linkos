// F-092 Need↔Offer 매칭 — 백서 §7 privacy_penalty + "민감필드 제외" (AI 표: Match Engine)
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, type MatchProfile, privacyPenalty, rankMatches, sanitizeMatchProfile, sanitizeMatchText, scoreMatch } from "../src/match";

const me: MatchProfile = { id: "me", name: "나", offers: ["B2B SaaS 영업"], needs: ["의료 AI 영상판독 파트너"], industries: ["healthcare"], regions: ["seoul"] };
const cand = (over: Partial<MatchProfile> = {}): MatchProfile => ({ id: "c", name: "상대", offers: ["의료 AI 영상판독 솔루션"], needs: ["B2B SaaS 영업 채널"], industries: ["healthcare"], regions: ["seoul"], ...over });

describe("F-092 sensitive-field exclusion", () => {
  it.each([
    ["우울증 투병 중인 분과 교류", "health"],
    ["지지 정당이 같은 분", "politics"],
    ["기독교 신앙 모임", "religion"],
    ["연봉 1억 이상 네트워크", "personal_finance"],
    ["성적 지향이 같은 분", "sexual_life"],
    ["전과 기록 상담", "criminal_record"],
    ["유전자 검사 결과 공유", "genetic_biometric"],
    ["주민번호 900101-1234567", "national_id"],
    ["political affiliation: party member", "politics"],
    ["credit score coaching for me", "personal_finance"],
  ])("drops %s (%s)", (text, category) => {
    const r = sanitizeMatchText(text);
    expect(r.text).toBeNull();
    expect(r.categories).toContain(category);
  });

  it.each(["의료 AI 영상판독", "헬스케어 B2B 유통", "핀테크 대출 중개 플랫폼", "보안 진단 컨설팅", "지식재산권 자문", "cloud security audit", "시리즈A 투자"])(
    "keeps business topic %s untouched",
    (text) => expect(sanitizeMatchText(text)).toEqual({ text, categories: [] }),
  );

  it("strips personal phone/email but keeps the rest of the statement", () => {
    const r = sanitizeMatchText("물류 자동화 파트너 찾음 010-1234-5678 kim@example.com");
    expect(r.categories).toEqual(["personal_contact"]);
    expect(r.text).toBe("물류 자동화 파트너 찾음");
  });

  it("sanitizeMatchProfile reports withheld categories by field, never the text", () => {
    const s = sanitizeMatchProfile(cand({ needs: ["B2B SaaS 영업 채널", "우울증 투병 동료"], projects: ["지지 정당 캠프"] }));
    expect(s.profile.needs).toEqual(["B2B SaaS 영업 채널"]);
    expect(s.profile.projects).toEqual([]);
    expect(s.excluded).toEqual([
      { field: "needs", category: "health" },
      { field: "projects", category: "politics" },
    ]);
    expect(JSON.stringify(s.excluded)).not.toContain("우울증");
  });

  it("a sensitive Need can never produce a match or a reason on its own", () => {
    const a: MatchProfile = { id: "a", name: "A", offers: [], needs: ["우울증 투병 경험 공유"] };
    const b: MatchProfile = { id: "b", name: "B", offers: ["우울증 투병 경험 공유"], needs: [] };
    expect(scoreMatch(a, b)).toBeNull();
    expect(rankMatches(a, [b])).toEqual([]);
  });

  it("reasons never quote sensitive text", () => {
    const m = scoreMatch(me, cand({ offers: ["의료 AI 영상판독 솔루션", "기독교 신앙 모임 리더"] }))!;
    expect(m).not.toBeNull();
    expect(m.reasons.map((r) => r.text).join(" ")).not.toContain("기독교");
  });
});

describe("F-092 privacy_penalty (match_score = … − privacy_penalty)", () => {
  it("is 0 for a clean, fully visible candidate", () => {
    expect(privacyPenalty(cand(), 0)).toBe(0);
    expect(scoreMatch(me, cand())!.privacyPenalty).toBe(0);
  });

  it("is bounded by w.privacy and grows with restricted fields and withheld sensitive data", () => {
    const p1 = privacyPenalty(cand({ privacy: { restrictedFieldRatio: 0.5 } }), 0);
    const p2 = privacyPenalty(cand({ privacy: { restrictedFieldRatio: 1 } }), 0);
    const p3 = privacyPenalty(cand({ privacy: { restrictedFieldRatio: 1 } }), 5);
    expect(p1).toBeGreaterThan(0);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThanOrEqual(p2);
    expect(p3).toBeLessThanOrEqual(DEFAULT_WEIGHTS.privacy);
    expect(privacyPenalty(cand({ privacy: { restrictedFieldRatio: 7 } }), 99)).toBe(DEFAULT_WEIGHTS.privacy);
  });

  it("is subtracted from the weighted sum", () => {
    const clean = scoreMatch(me, cand())!;
    const restricted = scoreMatch(me, cand({ privacy: { restrictedFieldRatio: 1 } }))!;
    expect(restricted.privacyPenalty).toBeGreaterThan(0);
    expect(restricted.score).toBeCloseTo(Math.max(0, clean.score - restricted.privacyPenalty), 1);
    expect(restricted.score).toBeLessThan(clean.score);
  });

  it("withheld sensitive statements on the candidate lower the score; personal contact stripping does not", () => {
    const base = scoreMatch(me, cand())!.score;
    const sensitive = scoreMatch(me, cand({ needs: ["B2B SaaS 영업 채널", "지지 정당 모임"] }))!;
    const contact = scoreMatch(me, cand({ needs: ["B2B SaaS 영업 채널 010-1234-5678"] }))!;
    expect(sensitive.score).toBeLessThan(base);
    expect(contact.privacyPenalty).toBe(0);
  });

  it("score stays within [0,1] even when the penalty exceeds the positive terms", () => {
    const w = { ...DEFAULT_WEIGHTS, privacy: 1 };
    const m = scoreMatch(me, cand({ privacy: { restrictedFieldRatio: 1 }, needs: ["B2B SaaS 영업 채널", "지지 정당", "우울증 투병"] }), w);
    if (m) expect(m.score).toBeGreaterThanOrEqual(0);
  });
});
