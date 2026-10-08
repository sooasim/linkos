// 백서 7. match_score = w1*semantic(Need,Offer) + w2*industry_fit + w3*geo_fit + w4*relationship_trust + w5*project_timing - privacy_penalty
// F-025/F-026 Offer/Need, F-092 Need↔Offer 매칭, F-097~ Match. 결과는 항상 설명 가능한 근거(reasons)를 포함하고 "AI 추론"으로 표시된다.
// 백서 §7 AI 표: Match Engine — "민감필드 제외, 설명 제공". 민감정보(개인정보보호법 제23조·GDPR 9조 범주: 건강·종교/신념·
// 정치/노조·성생활·인종/민족·범죄경력·유전/생체) + 개인 재무 + 개인 연락처(전화/이메일)·주민번호는 매칭 입력에서 제외한다.

export interface MatchProfile {
  id: string;
  name: string;
  offers: string[];
  needs: string[];
  industries?: string[];
  regions?: string[];
  projects?: string[];
  /** 0..1 existing relationship strength with the viewer */
  trust?: number;
  /** profile owner opted out of matching or hides fields */
  matchingOptOut?: boolean;
  /** privacy signals feeding privacy_penalty (all optional) */
  privacy?: {
    /** 0..1 share of the candidate's Offer/Need fields that are not visible to the viewer's audience */
    restrictedFieldRatio?: number;
  };
}

export interface MatchWeights {
  semantic: number;
  industry: number;
  geo: number;
  trust: number;
  timing: number;
  /** upper bound of the subtracted privacy_penalty term */
  privacy: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = { semantic: 0.55, industry: 0.15, geo: 0.1, trust: 0.1, timing: 0.1, privacy: 0.2 };

// ---------- F-092 sensitive-field exclusion ----------
export const SENSITIVE_CATEGORIES = [
  "health",
  "religion",
  "politics",
  "sexual_life",
  "ethnicity",
  "criminal_record",
  "genetic_biometric",
  "personal_finance",
  "national_id",
  "personal_contact",
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

// Patterns aim at statements about a *person* (e.g. "우울증 투병", "지지 정당") — not business topics such as
// "의료 AI", "헬스케어", "핀테크 대출 플랫폼" or "보안 진단", which remain valid Offer/Need text.
const SENSITIVE_PATTERNS: [Exclude<SensitiveCategory, "personal_contact" | "national_id">, RegExp][] = [
  ["health", /(건강\s?상태|건강\s?정보|병력|지병|질병\s?이력|투병|임신\s?중|정신과\s?치료|우울증|공황장애|장애\s?등급|장애\s?판정|diagnosed with|chronic illness|my (illness|disease|diagnosis)|disability status|pregnan|mental health|medical (history|condition)|health (condition|status))/iu],
  ["religion", /(종교|신앙|기독교|천주교|개신교|불교\s?신자|이슬람|무슬림|religio|christian|catholic|muslim|buddhist|\bfaith\b)/iu],
  ["politics", /(정치\s?성향|정치적\s?견해|지지\s?정당|정당\s?가입|당원|노동조합|노조\s?가입|political (view|opinion|affiliation|party)|party member|trade union|union membership)/iu],
  ["sexual_life", /(성적\s?지향|성생활|동성애|sexual orientation|sex life|\bgay\b|lesbian|bisexual|transgender)/iu],
  ["ethnicity", /(인종|민족성|출신\s?민족|ethnicit|\bracial\b)/iu],
  ["criminal_record", /(전과\s?기록|전과자|범죄\s?경력|수감\s?이력|criminal record|convicted of)/iu],
  ["genetic_biometric", /(유전\s?정보|유전자\s?검사|생체\s?정보|genetic test|biometric data|dna test)/iu],
  ["personal_finance", /(연봉|월급|개인\s?소득|개인\s?부채|빚|신용\s?등급|신용\s?점수|개인\s?재산|재산\s?규모|개인\s?파산|salary|personal (income|debt|loan)|credit score|net worth|bankrupt)/iu],
];
const CONTACT_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTACT_PHONE = /(?:[+＋]?\p{Nd}[\p{Nd}\s().\-－（）．]{7,}\p{Nd})/gu;
const NATIONAL_ID = /\b\d{6}\s?[-–]\s?[1-8]\d{6}\b/;

/**
 * F-092: decide what of one Offer/Need/project string may feed matching. A sensitive statement is dropped entirely
 * (text=null); personal phone numbers / emails are stripped and the remainder kept. Never returns new facts.
 */
export function sanitizeMatchText(text: string): { text: string | null; categories: SensitiveCategory[] } {
  const categories: SensitiveCategory[] = [];
  if (NATIONAL_ID.test(text)) categories.push("national_id");
  for (const [cat, re] of SENSITIVE_PATTERNS) if (re.test(text)) categories.push(cat);
  if (categories.length) return { text: null, categories };
  const stripped = text.replace(CONTACT_EMAIL, " ").replace(CONTACT_PHONE, " ").replace(/\s+/g, " ").trim();
  if (stripped !== text.replace(/\s+/g, " ").trim()) categories.push("personal_contact");
  return { text: stripped || null, categories };
}

export interface SanitizedMatchProfile {
  profile: MatchProfile;
  /** what was withheld (category + field only — never the text) */
  excluded: { field: "offers" | "needs" | "projects"; category: SensitiveCategory }[];
}

/** Remove sensitive inputs from a profile before scoring (taxonomy fields — industries/regions — are kept). */
export function sanitizeMatchProfile(p: MatchProfile): SanitizedMatchProfile {
  const excluded: SanitizedMatchProfile["excluded"] = [];
  const clean = (field: "offers" | "needs" | "projects", list: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const item of list ?? []) {
      const r = sanitizeMatchText(item);
      for (const category of r.categories) excluded.push({ field, category });
      if (r.text) out.push(r.text);
    }
    return out;
  };
  return {
    profile: { ...p, offers: clean("offers", p.offers), needs: clean("needs", p.needs), projects: p.projects ? clean("projects", p.projects) : undefined },
    excluded,
  };
}

/**
 * 백서 §7 privacy_penalty ∈ [0, w.privacy]: grows with how much of the candidate's data the viewer may not see
 * (restrictedFieldRatio) and with sensitive statements found (and withheld) in the candidate's Offer/Need — such
 * profiles are surfaced more conservatively because a match could hint at the withheld data.
 */
export function privacyPenalty(cand: MatchProfile, excludedSensitive: number, w: MatchWeights = DEFAULT_WEIGHTS): number {
  const restricted = Math.max(0, Math.min(1, cand.privacy?.restrictedFieldRatio ?? 0));
  const risk = Math.min(1, 0.6 * restricted + 0.25 * Math.min(excludedSensitive, 2));
  return Math.round(w.privacy * risk * 1000) / 1000;
}

export interface MatchReason {
  kind: "need_offer" | "offer_need" | "industry" | "region" | "trust" | "project";
  text: string;
  weight: number;
}

export interface MatchResult {
  subjectId: string;
  candidateId: string;
  candidateName: string;
  score: number; // 0..1
  reasons: MatchReason[];
  provenance: "ai_inferred";
  /** subtracted privacy_penalty term (0 = none) */
  privacyPenalty: number;
}

const STOP = new Set([
  "the", "and", "for", "with", "our", "we", "a", "an", "of", "to", "in", "on", "is", "are", "you", "i",
  "을", "를", "이", "가", "은", "는", "의", "에", "와", "과", "및", "또는", "등", "위한", "있는", "합니다", "필요", "제공",
]);

/** Language-agnostic tokenization: words for Latin, character bigrams for CJK. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (/[ㄱ-힝぀-ヿ一-鿿]/.test(w)) {
      // strip common Korean particles at end
      const stem = w.replace(/(을|를|이|가|은|는|의|에|와|과|에서|으로|로|도)$/, "");
      if (stem.length === 1) out.add(stem);
      for (let i = 0; i < stem.length - 1; i++) out.add(stem.slice(i, i + 2));
    } else if (w.length > 2) {
      out.add(w.replace(/(ing|ers|er|s)$/, ""));
    }
  }
  return out;
}

export function textSimilarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.sqrt(A.size * B.size); // cosine on binary vectors
}

function overlap(a: string[] = [], b: string[] = []): string[] {
  const B = new Set(b.map((x) => x.toLowerCase().trim()));
  return a.filter((x) => B.has(x.toLowerCase().trim()));
}

export function scoreMatch(rawSubject: MatchProfile, rawCand: MatchProfile, w: MatchWeights = DEFAULT_WEIGHTS): MatchResult | null {
  if (rawSubject.id === rawCand.id || rawCand.matchingOptOut) return null;
  // F-092: sensitive fields never reach the scorer (neither side)
  const subject = sanitizeMatchProfile(rawSubject).profile;
  const sc = sanitizeMatchProfile(rawCand);
  const cand = sc.profile;
  const penalty = privacyPenalty(rawCand, sc.excluded.filter((e) => e.category !== "personal_contact").length, w);
  const reasons: MatchReason[] = [];
  let best = 0;
  for (const need of subject.needs) {
    for (const offer of cand.offers) {
      const s = textSimilarity(need, offer);
      if (s > 0.15) reasons.push({ kind: "need_offer", text: `내 Need “${need}” ↔ 상대 Offer “${offer}”`, weight: s });
      best = Math.max(best, s);
    }
  }
  for (const offer of subject.offers) {
    for (const need of cand.needs) {
      const s = textSimilarity(offer, need);
      if (s > 0.15) reasons.push({ kind: "offer_need", text: `내 Offer “${offer}” ↔ 상대 Need “${need}”`, weight: s * 0.8 });
      best = Math.max(best, s * 0.8);
    }
  }
  const ind = overlap(subject.industries, cand.industries);
  if (ind.length) reasons.push({ kind: "industry", text: `공통 산업: ${ind.join(", ")}`, weight: w.industry });
  const geo = overlap(subject.regions, cand.regions);
  if (geo.length) reasons.push({ kind: "region", text: `활동 지역: ${geo.join(", ")}`, weight: w.geo });
  const trust = Math.max(0, Math.min(1, cand.trust ?? 0));
  if (trust > 0.3) reasons.push({ kind: "trust", text: "기존 관계 신뢰도", weight: trust * w.trust });
  const proj = (subject.projects ?? []).some((p) => (cand.offers ?? []).some((o) => textSimilarity(p, o) > 0.2));
  if (proj) reasons.push({ kind: "project", text: "진행 프로젝트와 관련된 역량", weight: w.timing });

  const semantic = Math.min(1, best * 1.4);
  const score =
    w.semantic * semantic +
    w.industry * (ind.length ? 1 : 0) +
    w.geo * (geo.length ? 1 : 0) +
    w.trust * trust +
    w.timing * (proj ? 1 : 0) -
    penalty;
  if (semantic === 0 && score < 0.2) return null;
  reasons.sort((a, b) => b.weight - a.weight);
  return {
    subjectId: subject.id,
    candidateId: cand.id,
    candidateName: cand.name,
    score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100,
    reasons: reasons.slice(0, 4),
    provenance: "ai_inferred",
    privacyPenalty: penalty,
  };
}

export function rankMatches(subject: MatchProfile, pool: MatchProfile[], limit = 20): MatchResult[] {
  return pool
    .map((c) => scoreMatch(subject, c))
    .filter((m): m is MatchResult => m !== null && m.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
