// 백서 7. match_score = w1*semantic(Need,Offer) + w2*industry_fit + w3*geo_fit + w4*relationship_trust + w5*project_timing - privacy_penalty
// F-025/F-026 Offer/Need, F-097~ Match. 결과는 항상 설명 가능한 근거(reasons)를 포함하고 "AI 추론"으로 표시된다.

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
}

export interface MatchWeights {
  semantic: number;
  industry: number;
  geo: number;
  trust: number;
  timing: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = { semantic: 0.55, industry: 0.15, geo: 0.1, trust: 0.1, timing: 0.1 };

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

export function scoreMatch(subject: MatchProfile, cand: MatchProfile, w: MatchWeights = DEFAULT_WEIGHTS): MatchResult | null {
  if (subject.id === cand.id || cand.matchingOptOut) return null;
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
    w.timing * (proj ? 1 : 0);
  if (semantic === 0 && score < 0.2) return null;
  reasons.sort((a, b) => b.weight - a.weight);
  return {
    subjectId: subject.id,
    candidateId: cand.id,
    candidateName: cand.name,
    score: Math.round(Math.min(1, score) * 100) / 100,
    reasons: reasons.slice(0, 4),
    provenance: "ai_inferred",
  };
}

export function rankMatches(subject: MatchProfile, pool: MatchProfile[], limit = 20): MatchResult[] {
  return pool
    .map((c) => scoreMatch(subject, c))
    .filter((m): m is MatchResult => m !== null && m.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
