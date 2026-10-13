// N-016 설명 가능한 추천 랭킹 · N-108 Evidence 객체와 근거 추적.
// 지침: docs/NETWORK_INTELLIGENCE.md §5.
//
// S = .25·intentFit + .18·capabilityFit + .16·pathQuality + .12·relationshipStrength
//   + .08·industryFit + .07·evidenceQuality + .05·recency + .04·geo + .03·dealHistory + .02·userPreference
//
// 두 가지 규칙이 이 파일의 존재 이유다.
//  1) Hard gate 는 점수보다 **먼저** 적용된다. 점수로 동의·필수조건을 상쇄할 수 없다.
//  2) 모든 추천 이유는 재현 가능해야 한다 — 상호작용 주장은 evidenceId 를 반드시 가진다.

import { type CandidateIdentity, type DisclosedCandidate, type DisclosureDecision, type MaskedFacets, type NextAction, applyDisclosure, nextActions } from "./disclosure";
import { textSimilarity } from "./match";
import type { RankedPath } from "./pathRank";
import { pathQualityFeature } from "./pathRank";
import { type SearchIntent, type TargetType } from "./searchIntent";
import { industryWithParents } from "./taxonomy";

export const RECO_FEATURES = [
  "intentFit",
  "capabilityFit",
  "pathQuality",
  "relationshipStrength",
  "industryFit",
  "evidenceQuality",
  "recency",
  "geo",
  "dealHistory",
  "userPreference",
] as const;
export type RecoFeature = (typeof RECO_FEATURES)[number];

export const RECO_WEIGHTS: Record<RecoFeature, number> = {
  intentFit: 0.25,
  capabilityFit: 0.18,
  pathQuality: 0.16,
  relationshipStrength: 0.12,
  industryFit: 0.08,
  evidenceQuality: 0.07,
  recency: 0.05,
  geo: 0.04,
  dealHistory: 0.03,
  userPreference: 0.02,
};

const clamp = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

// ---------- Evidence (N-108) ----------

export const EVIDENCE_TYPES = ["business_card", "user_confirmed", "meeting", "interaction", "referral", "note", "company_data", "org_membership", "ai_inferred"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface Evidence {
  id: string;
  type: EvidenceType;
  /** 사용자에게 보여줄 한 줄 요약. 전화·이메일 원문을 넣지 않는다 */
  summary: string;
  confidence: number;
  occurredAt: string | null;
  /** AI 추론인가 — 화면에서 확정 사실과 구분 표시해야 한다 */
  inferred: boolean;
}

/** 원천 신뢰도. user_confirmed 가 가장 높고 ai_inferred 가 가장 낮다. */
const EVIDENCE_SOURCE_WEIGHT: Record<EvidenceType, number> = {
  user_confirmed: 1,
  meeting: 0.95,
  business_card: 0.9,
  referral: 0.9,
  interaction: 0.8,
  org_membership: 0.75,
  company_data: 0.7,
  note: 0.65,
  ai_inferred: 0.4,
};

/**
 * evidenceQuality: 근거의 양·신뢰도·최근성·추론비중을 하나로 모은다.
 * 근거가 없으면 0 이다 — "근거 없음"을 0.5 같은 중립값으로 올려주지 않는다.
 */
export function evidenceQuality(evidence: Evidence[], now: Date = new Date()): number {
  if (!evidence.length) return 0;
  let acc = 0;
  for (const e of evidence) {
    const src = EVIDENCE_SOURCE_WEIGHT[e.type] ?? 0.5;
    const age = e.occurredAt ? (now.getTime() - new Date(e.occurredAt).getTime()) / 864e5 : null;
    const recency = age == null ? 0.6 : Math.exp(-Math.max(0, age) / 540); // 18개월 기준 감쇠
    acc += src * clamp(e.confidence) * (0.55 + 0.45 * recency);
  }
  // 근거 3건이면 거의 포화 — 양보다 질을 본다
  return r3(clamp((acc / evidence.length) * Math.min(1, 0.5 + evidence.length / 6)));
}

// ---------- feature 계산 ----------

export interface CandidateFacts {
  industries: string[];
  regions: string[];
  roleCategories: string[];
  /** 상대가 제공 가능한 것 */
  capabilities: string[];
  /** 상대가 필요하다고 밝힌 것 */
  needs: string[];
  type: TargetType;
  /** relationshipStrength().score — 직접 관계가 없으면 0 */
  relationshipStrength: number;
  /** 마지막 접촉 이후 일수. 없으면 null */
  daysSinceLastContact: number | null;
  dealsWon: number;
  /** 사용자가 이 후보/회사를 과거에 저장·소개요청했는가 */
  userPreference: number;
  confidence: number;
}

/** intentFit: 파싱된 조건을 몇 개나 실제로 만족하는가. 타입 불일치는 강한 감점이다. */
export function scoreIntentFit(intent: SearchIntent, c: CandidateFacts): number {
  const checks: number[] = [];
  if (intent.targetTypes.length) checks.push(intent.targetTypes.includes(c.type) ? 1 : 0);
  if (intent.industries.length) checks.push(overlapRatio(intent.industries.flatMap(industryWithParents), c.industries.flatMap(industryWithParents)));
  if (intent.geographies.length) checks.push(overlapRatio(intent.geographies, c.regions));
  if (intent.roles.length) checks.push(overlapRatio(intent.roles, c.roleCategories));
  if (intent.capabilities.length) checks.push(bestSimilarity(intent.capabilities, c.capabilities));
  if (!checks.length) return 0.5; // 조건이 없는 질의 — 중립
  return r3(checks.reduce((a, b) => a + b, 0) / checks.length);
}

/** capabilityFit: 내가 찾는 역량 ↔ 상대의 Capability 의미 유사도. */
export function scoreCapabilityFit(wanted: string[], c: CandidateFacts): number {
  if (!wanted.length) return 0;
  return r3(Math.min(1, bestSimilarity(wanted, [...c.capabilities, ...c.industries]) * 1.3));
}

export function scoreIndustryFit(intent: SearchIntent, c: CandidateFacts): number {
  if (!intent.industries.length) return 0;
  return r3(overlapRatio(intent.industries.flatMap(industryWithParents), c.industries.flatMap(industryWithParents)));
}

export function scoreGeoFit(intent: SearchIntent, c: CandidateFacts): number {
  if (!intent.geographies.length) return 0;
  return r3(overlapRatio(intent.geographies, c.regions));
}

function overlapRatio(want: string[], have: string[]): number {
  if (!want.length) return 0;
  const H = new Set(have.map((x) => x.toLowerCase().trim()));
  const hit = new Set(want.filter((w) => H.has(w.toLowerCase().trim())));
  return clamp(hit.size / new Set(want.map((w) => w.toLowerCase().trim())).size);
}

function bestSimilarity(a: string[], b: string[]): number {
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, textSimilarity(x, y));
  return clamp(best);
}

export function deriveFeatures(intent: SearchIntent, c: CandidateFacts, paths: RankedPath[], evidence: Evidence[], now: Date = new Date()): Record<RecoFeature, number> {
  return {
    intentFit: scoreIntentFit(intent, c),
    capabilityFit: scoreCapabilityFit(intent.capabilities, c),
    pathQuality: pathQualityFeature(paths),
    relationshipStrength: clamp(c.relationshipStrength),
    industryFit: scoreIndustryFit(intent, c),
    evidenceQuality: evidenceQuality(evidence, now),
    recency: c.daysSinceLastContact == null ? 0 : clamp(Math.exp(-Math.max(0, c.daysSinceLastContact) / 180)),
    geo: scoreGeoFit(intent, c),
    dealHistory: clamp(Math.min(1, c.dealsWon / 2)),
    userPreference: clamp(c.userPreference),
  };
}

// ---------- Hard gate (점수보다 먼저) ----------

export const HARD_GATE_REASONS = ["blocked", "deleted", "not_discoverable", "must_have_unmet", "below_min_confidence", "self"] as const;
export type HardGateReason = (typeof HARD_GATE_REASONS)[number];

export interface HardGateInput {
  isSelf: boolean;
  blocked: boolean;
  deleted: boolean;
  /** evaluateDisclosure().gates.can_discover */
  canDiscover: boolean;
  /** intent.mustHave 를 전부 만족하는가. 하나라도 못 만족하면 탈락이다 */
  mustHaveUnmet: string[];
  confidence: number;
  minConfidence: number;
}

/** 통과하지 못하면 후보는 **목록에서 사라진다.** 점수를 깎는 것이 아니다. */
export function hardGate(g: HardGateInput): { pass: boolean; reason: HardGateReason | null; detail?: string } {
  if (g.isSelf) return { pass: false, reason: "self" };
  if (g.deleted) return { pass: false, reason: "deleted" };
  if (g.blocked) return { pass: false, reason: "blocked" };
  if (!g.canDiscover) return { pass: false, reason: "not_discoverable" };
  if (g.mustHaveUnmet.length) return { pass: false, reason: "must_have_unmet", detail: g.mustHaveUnmet.join(", ") };
  if (g.confidence < g.minConfidence) return { pass: false, reason: "below_min_confidence" };
  return { pass: true, reason: null };
}

/** intent.mustHave 중 후보가 만족하지 못한 항목. 분류값 일치 또는 의미 유사도 0.3 이상을 만족으로 본다. */
export function unmetMustHave(mustHave: string[], c: CandidateFacts): string[] {
  const haystack = [...c.industries, ...c.regions, ...c.roleCategories, ...c.capabilities];
  return mustHave.filter((m) => {
    const low = m.toLowerCase();
    if (haystack.some((h) => h.toLowerCase().includes(low) || low.includes(h.toLowerCase()))) return false;
    return bestSimilarity([m], haystack) < 0.3;
  });
}

// ---------- 점수 ----------

export interface ScoreComponent {
  feature: RecoFeature;
  value: number;
  weight: number;
  contribution: number;
}

export interface ScoredRecommendation {
  /** 0..100 */
  score: number;
  components: ScoreComponent[];
  scoreComponents: Record<RecoFeature, number>;
}

export function scoreRecommendation(features: Partial<Record<RecoFeature, number>>): ScoredRecommendation {
  const components: ScoreComponent[] = RECO_FEATURES.map((feature) => {
    const value = clamp(features[feature] ?? 0);
    const weight = RECO_WEIGHTS[feature];
    return { feature, value: r3(value), weight, contribution: r3(weight * value) };
  });
  const raw = components.reduce((a, c) => a + c.contribution, 0);
  return {
    score: Math.round(100 * clamp(raw) * 1000) / 1000,
    components: [...components].sort((a, b) => b.contribution - a.contribution),
    scoreComponents: Object.fromEntries(components.map((c) => [c.feature, c.value])) as Record<RecoFeature, number>,
  };
}

// ---------- 근거 있는 이유 (N-108) ----------

export interface RecoReason {
  text: string;
  /** 이 이유를 만든 feature */
  feature: RecoFeature;
  /**
   * field = 구조화 필드에서 바로 재현 가능(산업·지역 일치 등)
   * evidence = 상호작용/사실 주장 → evidenceId 필수
   * score = 점수 구성 설명(사실 주장이 아니다)
   */
  source: "field" | "evidence" | "score";
  evidenceId: string | null;
  inferred: boolean;
}

/**
 * 근거 규칙 검증: `source === "evidence"` 인 이유는 반드시 실재하는 evidenceId 를 갖는다.
 * 인수 게이트("추천 top reason 100% 가 evidenceId/feature 에 연결")를 코드로 강제한다.
 */
export function groundedReasons(reasons: RecoReason[], evidence: Evidence[]): RecoReason[] {
  const ids = new Set(evidence.map((e) => e.id));
  return reasons.filter((r) => r.source !== "evidence" || (r.evidenceId !== null && ids.has(r.evidenceId)));
}

function buildReasons(intent: SearchIntent, c: CandidateFacts, f: Record<RecoFeature, number>, evidence: Evidence[], paths: RankedPath[]): RecoReason[] {
  const out: RecoReason[] = [];
  const ind = intent.industries.filter((i) => c.industries.includes(i));
  if (ind.length) out.push({ text: `산업 일치: ${ind.join(", ")}`, feature: "industryFit", source: "field", evidenceId: null, inferred: false });
  const geo = intent.geographies.filter((g) => c.regions.includes(g));
  if (geo.length) out.push({ text: `지역 일치: ${geo.join(", ")}`, feature: "geo", source: "field", evidenceId: null, inferred: false });
  const role = intent.roles.filter((rr) => c.roleCategories.includes(rr));
  if (role.length) out.push({ text: `역할 일치: ${role.join(", ")}`, feature: "intentFit", source: "field", evidenceId: null, inferred: false });
  if (f.capabilityFit > 0.25 && c.capabilities.length) {
    out.push({ text: `찾는 역량과 맞는 Capability: ${c.capabilities.slice(0, 2).join(", ")}`, feature: "capabilityFit", source: "field", evidenceId: null, inferred: false });
  }
  // 상호작용 주장은 근거 id 를 달고 나간다
  for (const e of evidence.filter((x) => x.type === "meeting" || x.type === "interaction" || x.type === "referral").slice(0, 2)) {
    out.push({ text: e.summary, feature: e.type === "referral" ? "dealHistory" : "recency", source: "evidence", evidenceId: e.id, inferred: e.inferred });
  }
  if (f.relationshipStrength > 0) {
    const relEv = evidence.find((e) => e.type === "user_confirmed" || e.type === "business_card");
    out.push({ text: `관계 강도 ${Math.round(f.relationshipStrength * 100)}점`, feature: "relationshipStrength", source: relEv ? "evidence" : "score", evidenceId: relEv?.id ?? null, inferred: false });
  }
  if (paths.length) {
    const best = paths[0]!;
    out.push({ text: best.hops === 1 ? "직접 아는 사이입니다" : `${best.hops}촌 소개 경로가 있습니다 (대안 ${paths.length - 1}개)`, feature: "pathQuality", source: "score", evidenceId: null, inferred: false });
  }
  return out;
}

// ---------- 최종 조립 ----------

export interface Recommendation extends DisclosedCandidate {
  score: number;
  scoreComponents: Record<RecoFeature, number>;
  reasons: RecoReason[];
  evidence: Evidence[];
  paths: RankedPath[];
  nextActions: NextAction[];
}

export interface BuildRecommendationInput {
  identity: CandidateIdentity;
  facts: CandidateFacts;
  disclosure: DisclosureDecision;
  facets: Omit<MaskedFacets, "roleCategory"> & { roleCategory?: string | null };
  evidence: Evidence[];
  paths: RankedPath[];
  /** 소유권·차단·삭제만 넘긴다. 동의·필수조건·confidence 는 이 함수가 직접 계산한다 */
  gate: Omit<HardGateInput, "mustHaveUnmet" | "canDiscover" | "confidence" | "minConfidence">;
  intent: SearchIntent;
  minConfidence?: number;
  now?: Date;
}

/**
 * 후보 하나를 응답 형태로 만든다. 순서가 중요하다:
 *   hard gate → disclosure 변환 → feature → 점수 → 근거 검증
 * gate 에서 탈락하면 null 이고, 호출자는 결과에 넣지 않는다.
 */
export function buildRecommendation(input: BuildRecommendationInput): Recommendation | null {
  const unmet = unmetMustHave(input.intent.mustHave, input.facts);
  const gate = hardGate({
    ...input.gate,
    canDiscover: input.disclosure.gates.can_discover,
    mustHaveUnmet: unmet,
    confidence: input.facts.confidence,
    minConfidence: input.minConfidence ?? 0.55,
  });
  if (!gate.pass) return null;

  const disclosed = applyDisclosure(input.identity, input.disclosure, input.facets);
  if (!disclosed) return null;

  const features = deriveFeatures(input.intent, input.facts, input.paths, input.evidence, input.now);
  const scored = scoreRecommendation(features);
  const reasons = groundedReasons(buildReasons(input.intent, input.facts, features, input.evidence, input.paths), input.evidence);

  return {
    ...disclosed,
    score: scored.score,
    scoreComponents: scored.scoreComponents,
    reasons: reasons.slice(0, 5),
    // masked 후보에게도 근거는 보여주되 당사자를 식별하는 요약은 담지 않는다(요약 생성 책임은 호출자에게 있다)
    evidence: input.evidence,
    paths: input.paths,
    nextActions: nextActions(input.disclosure),
  };
}

// ---------- 다양성 (MMR) ----------

export const MMR_LAMBDA = 0.82;

/** 후보 간 유사도 — 같은 회사·같은 산업·같은 소개자면 비슷하다고 본다. */
function candidateSimilarity(a: Recommendation, b: Recommendation): number {
  let s = 0;
  if (a.companyName && a.companyName === b.companyName) s += 0.6;
  if (a.industry && a.industry === b.industry) s += 0.25;
  const ai = a.paths[0]?.introducerId;
  const bi = b.paths[0]?.introducerId;
  if (ai && ai === bi) s += 0.3;
  return Math.min(1, s);
}

/**
 * Maximal Marginal Relevance. 같은 회사·같은 소개자가 Top-N 을 점유하지 않게 한다.
 * λ=0.82 로 시작한다(패키지 §8).
 */
export function diversify(results: Recommendation[], limit = 20, lambda = MMR_LAMBDA): Recommendation[] {
  const pool = [...results].sort((a, b) => b.score - a.score);
  const picked: Recommendation[] = [];
  while (picked.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const sim = picked.length ? Math.max(...picked.map((p) => candidateSimilarity(c, p))) : 0;
      const val = lambda * (c.score / 100) - (1 - lambda) * sim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(pool.splice(bestIdx, 1)[0]!);
  }
  return picked;
}

// ---------- 학습 라벨 (N-303 준비) ----------

export const OUTCOME_LABELS = ["intro_requested", "intro_approved", "introduced", "meeting_held", "qualified", "won", "lost", "wrong_relationship", "not_relevant", "privacy_blocked"] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** funnel 순서. CTR 보다 아래 단계를 우선해 학습한다(패키지 §9). */
export const OUTCOME_FUNNEL: OutcomeLabel[] = ["intro_requested", "intro_approved", "introduced", "meeting_held", "qualified", "won"];

export function isNegativeOutcome(l: OutcomeLabel): boolean {
  return l === "lost" || l === "wrong_relationship" || l === "not_relevant" || l === "privacy_blocked";
}
