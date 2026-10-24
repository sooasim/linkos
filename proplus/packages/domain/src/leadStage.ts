/**
 * 리드 단계(stage) 전이 — P-104 (모듈명세 M07).
 *
 * `leads.stage` 는 `lead_stage` enum 이고 변경 이력은 `lead_stage_history` 가 모두 받는다.
 * 그래서 이 모듈은 "되돌리기 금지"가 아니라 **되돌릴 수 있지만 흔적이 남는다**를 전제로 한다 —
 * 영업 단계는 오기입이 잦아서 수정을 막으면 담당자가 메모에 진실을 적고 단계는 거짓이 된다.
 *
 * 딱 하나만 강하게 막는다: **종료(won|lost) 에서 'new' 로 되돌리기.**
 * 'new' 는 리드 inbox 의 진입 상태이고 "아직 아무도 손대지 않음"을 뜻한다. 이미 성약/실패까지
 * 간 리드를 거기로 되돌리면 inbox 가 끝난 일을 새 일로 보여주고, 담당자 배정이 초기화된 것처럼
 * 읽힌다. 그래서 재개는 최소 'contacted' 부터다.
 *
 * ⚠️ 응답시간 지표(P-111 / N-8)의 분모는 **단계가 아니라 `leads.first_response_at`** 이다.
 *    그 컬럼은 단계를 되돌려도 지워지지 않는다 — 그래서 `contacted → new` 를 허용해도
 *    지표가 오염되지 않는다. 지표를 지키려고 이 전이를 막는 것이 아니다(그렇게 적어 두면
 *    다음 사람이 "그럼 contacted → new 도 막아야 하지 않나"로 잘못 고친다).
 */

import { LEAD_STAGES, type LeadStage } from "./types";

/** 파이프라인 순서. 인덱스가 곧 진행도다. */
const STAGE_INDEX: Record<LeadStage, number> = {
  new: 0,
  contacted: 1,
  qualified: 2,
  proposal: 3,
  won: 4,
  lost: 5,
};

/** 되돌리기의 하한. 종료 상태에서 재개할 때는 최소 "연락함"부터다. */
const REOPEN_MIN = STAGE_INDEX.contacted;

const CLOSED: ReadonlySet<LeadStage> = new Set<LeadStage>(["won", "lost"]);

export function canChangeStage(from: LeadStage, to: LeadStage): boolean {
  // 같은 단계로의 변경은 이력만 늘리고 아무 의미가 없다.
  if (from === to) return false;
  if (!isKnownStage(from) || !isKnownStage(to)) return false;

  if (CLOSED.has(from)) {
    // won → lost 같은 종료 간 수정은 허용된다(되돌리기가 아니라 결과 정정이다).
    // 막는 것은 'new' 로의 복귀뿐이다.
    return STAGE_INDEX[to] >= REOPEN_MIN;
  }

  return true;
}

/** 종료된 리드인가. 알림·후속 태스크·응답시간 집계에서 제외하는 기준이다. */
export function isClosed(s: LeadStage): boolean {
  return CLOSED.has(s);
}

/** 브랜드 §7 — 상태는 색만으로 구분하지 않으므로 라벨이 코드 상수로 있어야 한다. */
export const LEAD_STAGE_LABEL_KO: Record<LeadStage, string> = {
  new: "신규",
  contacted: "연락함",
  qualified: "검토 중",
  proposal: "제안",
  won: "성약",
  lost: "종료",
};

/** HTTP 본문에서 온 문자열이 실제 enum 값인지 — 타입만으로는 런타임을 지킬 수 없다. */
function isKnownStage(s: LeadStage): boolean {
  return (LEAD_STAGES as readonly string[]).includes(s);
}
