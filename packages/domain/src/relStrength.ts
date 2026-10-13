// N-103 관계강도 9신호 · N-104 감쇠와 휴면 경고 · 소개 엣지 품질(N-105 의 입력).
// 지침: docs/NETWORK_INTELLIGENCE.md §3, §4.
//
// R = .18·frequency + .18·recency + .15·reciprocity + .12·meeting_depth
//   + .10·deal_history + .10·tenure + .07·shared_context + .05·user_trust + .05·referral_success
//
// 기존 F-074 `computeStrength()`(6신호)는 유지한다 — 연락처 목록의 관계 강도 배지는 계속 그것을 쓴다.
// 이 모듈은 소개 경로 계산과 Relationship Intelligence 화면이 쓰는 상위 모델이며 F-074 의 신호를 흡수한다.

export const REL_SIGNAL_KINDS = [
  "frequency",
  "recency",
  "reciprocity",
  "meeting_depth",
  "deal_history",
  "tenure",
  "shared_context",
  "user_trust",
  "referral_success",
] as const;
export type RelSignalKind = (typeof REL_SIGNAL_KINDS)[number];

export const REL_WEIGHTS: Record<RelSignalKind, number> = {
  frequency: 0.18,
  recency: 0.18,
  reciprocity: 0.15,
  meeting_depth: 0.12,
  deal_history: 0.1,
  tenure: 0.1,
  shared_context: 0.07,
  user_trust: 0.05,
  referral_success: 0.05,
};

export type RelSignals = Record<RelSignalKind, number>;

const clamp = (x: number, lo = 0, hi = 1): number => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 관계 유형별 recency tau(일). 거래·투자 관계는 접촉이 드물어도 식지 않고, 지인은 빨리 식는다. */
export const RELATION_TYPES = ["knows", "colleague", "customer", "supplier", "partner", "investor", "advisor", "member", "worked_with"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

const TAU: Record<RelationType, number> = {
  knows: 120,
  colleague: 240,
  customer: 200,
  supplier: 200,
  partner: 300,
  investor: 420,
  advisor: 300,
  member: 180,
  worked_with: 270,
};

export function tauForRelation(t: RelationType = "knows"): number {
  return TAU[t] ?? 180;
}

/** recency = exp(-days / tau). 접촉 기록이 없으면 0 (추측하지 않는다). */
export function recencyDecay(days: number | null, tau = 180): number {
  if (days == null) return 0;
  return clamp(Math.exp(-Math.max(0, days) / Math.max(1, tau)));
}

// ---------- 원시 관측값 → 9신호 ----------

export interface RelObservations {
  daysSinceLastContact: number | null;
  encounters90d: number;
  encountersTotal: number;
  meetingsTotal: number;
  /** 함께한 미팅의 총 길이(분). 모르면 0 — 횟수만으로 계산한다. */
  meetingMinutesTotal: number;
  /** 내가 먼저 연락한 횟수 / 상대가 먼저 연락한 횟수. 양방향성의 직접 근거다. */
  outboundCount: number;
  inboundCount: number;
  /** 상대도 LINKOS 사용자이고 나를 주소록에 갖고 있다(양방향 교환) */
  reciprocal: boolean;
  dealsTotal: number;
  dealsWon: number;
  /** 처음 만난 뒤 지난 일수. 모르면 null */
  firstMetDaysAgo: number | null;
  /** 공유 맥락 개수: 같은 조직·행사·회사·태그 */
  sharedOrganizations: number;
  sharedEvents: number;
  sharedCompanies: number;
  /** 사용자가 직접 입력한 신뢰도 0..1. 없으면 null — 0 으로 치지 않고 가중치를 재분배한다. */
  userTrust: number | null;
  referralsGiven: number;
  referralsSucceeded: number;
  relationType?: RelationType;
  /** 사용자가 확인한 관계인가. false + inferred 면 confidence 상한이 걸린다. */
  confirmed: boolean;
  inferred: boolean;
}

export function deriveRelSignals(o: RelObservations): RelSignals {
  const tau = tauForRelation(o.relationType);
  const inb = Math.max(0, o.inboundCount);
  const out = Math.max(0, o.outboundCount);
  const bothWays = inb > 0 && out > 0 ? Math.min(inb, out) / Math.max(inb, out) : 0;
  return {
    // 최근 90일 접촉이 주 신호, 누적은 보조 (기존 F-074 와 같은 형태)
    frequency: clamp(Math.min(1, o.encounters90d / 4) * 0.7 + Math.min(1, o.encountersTotal / 10) * 0.3),
    recency: recencyDecay(o.daysSinceLastContact, tau),
    // 명시적 왕래가 있으면 그것을 믿고, 없으면 양방향 교환 여부로 대체한다
    reciprocity: clamp(inb + out > 0 ? bothWays * 0.75 + (o.reciprocal ? 0.25 : 0) : o.reciprocal ? 0.5 : 0),
    meeting_depth: clamp(Math.min(1, o.meetingsTotal / 3) * 0.6 + Math.min(1, o.meetingMinutesTotal / 180) * 0.4),
    deal_history: clamp(o.dealsTotal > 0 ? (o.dealsWon / o.dealsTotal) * 0.6 + Math.min(1, o.dealsWon / 2) * 0.4 : 0),
    tenure: clamp(o.firstMetDaysAgo == null ? 0 : 1 - Math.exp(-o.firstMetDaysAgo / 365)),
    shared_context: clamp(Math.min(1, (o.sharedOrganizations * 0.4 + o.sharedCompanies * 0.4 + o.sharedEvents * 0.2) / 2)),
    user_trust: o.userTrust == null ? 0 : clamp(o.userTrust),
    referral_success: clamp(o.referralsGiven > 0 ? o.referralsSucceeded / o.referralsGiven : 0),
  };
}

// ---------- 점수 ----------

export interface RelStrengthComponent {
  kind: RelSignalKind;
  value: number;
  weight: number;
  contribution: number;
  text: string;
  /** 이 신호를 뒷받침하는 evidence. 없으면 null — 그때는 설명에서 "근거 없음"으로 다룬다(N-108). */
  evidenceId: string | null;
}

export interface RelStrengthResult {
  /** 0..1 */
  score: number;
  /** 0..100 — 화면 표기용 */
  score100: number;
  band: "strong" | "medium" | "weak";
  components: RelStrengthComponent[];
  /** inferred-only 관계에 걸린 상한. 걸리지 않았으면 null */
  confidenceCap: number | null;
  /** N-104: 휴면 신호. 설명에 반드시 표시한다. */
  stale: { isStale: boolean; daysSinceLastContact: number | null; text: string | null };
}

const LABEL: Record<RelSignalKind, string> = {
  frequency: "접촉 빈도",
  recency: "최근성",
  reciprocity: "양방향성",
  meeting_depth: "미팅 깊이",
  deal_history: "거래 이력",
  tenure: "관계 기간",
  shared_context: "공유 맥락",
  user_trust: "직접 입력한 신뢰도",
  referral_success: "소개 성공률",
};

/** inferred(추론) 전용 관계는 확인된 관계와 동급으로 올라가지 않는다. */
export const INFERRED_ONLY_CAP = 0.6;

export interface RelStrengthOptions {
  /** 신호별 근거 id. 없는 신호는 생략 가능 */
  evidence?: Partial<Record<RelSignalKind, string>>;
  confirmed?: boolean;
  inferred?: boolean;
  daysSinceLastContact?: number | null;
  relationType?: RelationType;
}

export function relationshipStrength(s: RelSignals, opts: RelStrengthOptions = {}): RelStrengthResult {
  const components: RelStrengthComponent[] = REL_SIGNAL_KINDS.map((kind) => {
    const value = clamp(s[kind]);
    const weight = REL_WEIGHTS[kind];
    return {
      kind,
      value: r3(value),
      weight,
      contribution: r3(weight * value),
      text: `${LABEL[kind]} ${Math.round(value * 100)}점`,
      evidenceId: opts.evidence?.[kind] ?? null,
    };
  });
  let score = clamp(components.reduce((a, c) => a + c.contribution, 0));

  const inferredOnly = opts.inferred === true && opts.confirmed !== true;
  const confidenceCap = inferredOnly ? INFERRED_ONLY_CAP : null;
  if (confidenceCap != null) score = Math.min(score, confidenceCap);

  const days = opts.daysSinceLastContact ?? null;
  const tau = tauForRelation(opts.relationType);
  const isStale = days != null && days > tau * 1.5;

  return {
    score: r3(score),
    score100: Math.round(score * 100),
    band: score >= 0.55 ? "strong" : score >= 0.3 ? "medium" : "weak",
    components: components.sort((a, b) => b.contribution - a.contribution),
    confidenceCap,
    stale: {
      isStale,
      daysSinceLastContact: days,
      text: isStale ? `${Math.round(days)}일째 접촉이 없어 최근성 점수가 감쇠했습니다` : days == null ? "접촉 기록이 없어 최근성을 계산할 수 없습니다" : null,
    },
  };
}

// ---------- 소개 엣지 품질 (N-105 의 입력) ----------

export interface EdgeFactors {
  /** relationshipStrength().score */
  strength: number;
  /** 이 사람이 자기 네트워크를 소개해 줄 의향(공유 설정·과거 소개 수락률) */
  shareability: number;
  /** 지금 부탁할 수 있는 상태인가(최근 활동·응답성) */
  availability: number;
  /** 이번 요청 맥락(산업·목적)에 이 사람이 맞는가 */
  contextFit: number;
  /** evaluateDisclosure().consentGate — 0 이면 이 엣지로 소개 action 을 만들지 않는다 */
  consentGate: 0 | 1;
}

/**
 * E = R × shareability × availability × context_fit × consent_gate
 *
 * 곱셈 항이 5개라 보정 없이 쓰면 평범한 관계가 0 에 수축한다(그래프 명세의 경고). consent_gate 를 뺀
 * 나머지 factor 에 floor 를 적용해 "모르는 값"이 엣지를 죽이지 않게 한다. consent_gate 는 floor 없이 하드 0 이다.
 */
export const EDGE_FACTOR_FLOOR = 0.35;

export function edgeQuality(f: EdgeFactors): number {
  if (f.consentGate === 0) return 0;
  const g = (x: number): number => Math.max(EDGE_FACTOR_FLOOR, clamp(x));
  return r3(clamp(f.strength) * g(f.shareability) * g(f.availability) * g(f.contextFit));
}

/** shareability 기본값: 과거 소개 요청 수락률. 이력이 없으면 중립(0.5). */
export function shareabilityFrom(introRequests: number, introAccepted: number): number {
  if (introRequests <= 0) return 0.5;
  return clamp(introAccepted / introRequests);
}

/** availability 기본값: 마지막 활동으로부터의 감쇠. 90일 넘게 조용하면 부탁하기 어렵다고 본다. */
export function availabilityFrom(daysSinceLastActivity: number | null): number {
  if (daysSinceLastActivity == null) return 0.4;
  return recencyDecay(daysSinceLastActivity, 90);
}
