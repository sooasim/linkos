// N-021 Opportunity 파이프라인 — 탐지된 기회를 소개·미팅·성과까지 추적하는 상태머신.
// 지침: docs/NETWORK_INTELLIGENCE.md §12.
//
// `graph.ts` 의 `Opportunity`(Need↔Offer 탐지 결과, F-099)와 다른 레이어다.
// 그쪽은 "기회가 있을 것 같다"는 **탐지**이고, 여기는 그 기회를 사용자가 실제로 굴리는 **파이프라인**이다.
// 자동으로 상대에게 발송하지 않는다 — 모든 전이는 사용자 행동으로만 일어난다.

import { type OutcomeLabel } from "./recommend";

export const OPPORTUNITY_STAGES = ["detected", "qualified", "intro_requested", "introduced", "negotiating", "won", "lost", "dismissed"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/** 보드에 칼럼으로 보여줄 순서(S12). won/lost/dismissed 는 종료 상태라 마지막이다. */
export const OPPORTUNITY_BOARD_COLUMNS: OpportunityStage[] = ["detected", "qualified", "intro_requested", "introduced", "negotiating", "won", "lost"];

const NEXT: Record<OpportunityStage, OpportunityStage[]> = {
  detected: ["qualified", "dismissed"],
  qualified: ["intro_requested", "dismissed", "lost"],
  intro_requested: ["introduced", "lost", "dismissed"],
  introduced: ["negotiating", "won", "lost"],
  negotiating: ["won", "lost"],
  won: [],
  lost: [],
  dismissed: [],
};

export function canOpportunityTransition(from: OpportunityStage, to: OpportunityStage): boolean {
  return NEXT[from].includes(to);
}

export function nextOpportunityStages(from: OpportunityStage): OpportunityStage[] {
  return [...NEXT[from]];
}

export function isTerminalStage(s: OpportunityStage): boolean {
  return NEXT[s].length === 0;
}

/**
 * 단계 전이를 추천 학습 라벨로 바꾼다(N-303 준비). 라벨이 없는 전이는 null —
 * 모든 UI 클릭을 학습 신호로 쓰지 않는다(패키지 §9: CTR 보다 funnel 을 우선한다).
 */
export function outcomeLabelFor(to: OpportunityStage): OutcomeLabel | null {
  switch (to) {
    case "qualified":
      return "qualified";
    case "intro_requested":
      return "intro_requested";
    case "introduced":
      return "introduced";
    case "won":
      return "won";
    case "lost":
      return "lost";
    case "dismissed":
      return "not_relevant";
    default:
      return null;
  }
}

export const STAGE_LABELS: Record<OpportunityStage, string> = {
  detected: "탐지됨",
  qualified: "검토 완료",
  intro_requested: "소개 요청",
  introduced: "소개 완료",
  negotiating: "협의 중",
  won: "성사",
  lost: "무산",
  dismissed: "보류",
};

export interface OpportunityHealth {
  /** 단계에 머문 일수 */
  ageDays: number;
  stale: boolean;
  /** 다음에 할 일 한 줄 */
  nextStep: string;
}

/** 단계별 기대 체류 기간. 넘으면 보드에서 주의 표시한다. */
const STAGE_SLA_DAYS: Record<OpportunityStage, number> = {
  detected: 7,
  qualified: 14,
  intro_requested: 10,
  introduced: 21,
  negotiating: 45,
  won: Number.POSITIVE_INFINITY,
  lost: Number.POSITIVE_INFINITY,
  dismissed: Number.POSITIVE_INFINITY,
};

const NEXT_STEP: Record<OpportunityStage, string> = {
  detected: "기회가 실제로 맞는지 검토하고 Need 를 확인하세요",
  qualified: "소개 경로를 비교하고 중개자에게 소개를 요청하세요",
  intro_requested: "중개자의 응답을 기다리는 중입니다 — 응답이 없으면 대안 경로를 보세요",
  introduced: "첫 미팅을 잡으세요",
  negotiating: "협의 결과를 기록하면 다음 추천이 개선됩니다",
  won: "성과를 기록해 두면 비슷한 기회를 더 잘 찾습니다",
  lost: "무산 이유를 남기면 같은 추천이 반복되지 않습니다",
  dismissed: "보류된 기회입니다",
};

export function opportunityHealth(stage: OpportunityStage, stageEnteredAt: Date, now: Date = new Date()): OpportunityHealth {
  const ageDays = Math.max(0, Math.round((now.getTime() - stageEnteredAt.getTime()) / 864e5));
  return { ageDays, stale: ageDays > STAGE_SLA_DAYS[stage], nextStep: NEXT_STEP[stage] };
}
