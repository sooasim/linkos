/**
 * 요금제 한도 — P-141 (모듈명세 M10).
 *
 * ## N-2 가 이 파일에서 뜻하는 것 (보안정책 §4.10)
 *
 * `PlanLimits` 에 **배지·검증 관련 키가 하나도 없다.** 이것이 실수가 아니라 규칙이다.
 * `badgeSlots`, `verifiedBadges`, `prioritySupportForReview` 같은 키가 생기는 순간
 * "돈을 더 내면 배지를 더 받는다"가 되고, 그건 PROPLUS 가 파는 신뢰 자체를 무너뜨린다.
 * 배지 발급 판정(`badge.ts` 의 `canIssueBadge`)이 구독을 **인자로도 받지 않는** 것과 같은 규칙의
 * 반대쪽 짝이다. 요금제는 **기능 접근만** 제한한다 — 노출 공간(offers/blocks), 편의 기능(booking,
 * customDomain), 보관 기간(analyticsDays), 좌석(teamSeats).
 *
 * 값은 코드 상수가 아니라 `plans.limits` jsonb 레코드에서 온다 (P-140). 그래서 이 파일에는
 * Free/Pro/Business 숫자가 없다 — 숫자를 여기 박으면 요금제 변경이 배포를 요구하게 된다.
 *
 * ## jsonb 레코드 규약
 *
 * - **"무제한"을 표현하는 방법은 없다.** `null`·`Infinity` 는 둘 다 거부(fail-closed)로 떨어진다.
 *   JSON 에 `Infinity` 리터럴이 없고, `null` 을 무제한으로 읽으면 값이 빠진 레코드가
 *   조용히 무제한이 되기 때문이다. 사실상 무제한이 필요하면 **충분히 큰 유한수**(예: 1000000)를
 *   레코드에 적는다 — 의도가 레코드에 드러나는 쪽을 택한다.
 * - 수치 키가 레코드에 없으면 그 요금제에 그 기능이 없다는 뜻이다(거부).
 * - 불린 키가 없으면 기능 꺼짐이다.
 */

export interface PlanLimits {
  offers: number;
  blocks: number;
  customDomain: boolean;
  booking: boolean;
  analyticsDays: number;
  /** 팀 좌석. 개인 요금제에는 아예 없다(undefined) — 0 과 구분하기 위해 optional 이다. */
  teamSeats?: number;
}

/**
 * `current` 를 하나 더 늘릴 수 있는가.
 *
 * - 수치 키: `current < limit`. 호출부는 **생성 전**에 현재 개수를 넣는다.
 * - 불린 키: 기능 플래그이므로 `current` 를 무시하고 플래그를 그대로 돌려준다.
 * - 없는 키(teamSeats 미정의): 그 요금제에 그 기능이 없다는 뜻이므로 거부한다 (fail-closed).
 */
export function withinLimit(limits: PlanLimits, key: keyof PlanLimits, current: number): boolean {
  const limit = limits[key];

  if (typeof limit === "boolean") return limit;

  if (typeof limit !== "number" || !Number.isFinite(limit)) return false;

  if (!Number.isFinite(current)) return false;

  // 음수 `current` 는 "개수를 센 쿼리가 틀렸다"는 뜻이다. 그대로 비교하면 한도 0 인 요금제에서도
  // `-1 < 0` 이 참이 되어 **한도가 열린다**(fail-open). 셀 수 없으면 거부하는 쪽이 맞다.
  if (current < 0) return false;

  return current < limit;
}
