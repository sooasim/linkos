/**
 * 프로필 완성도 안내 — P-032 / N-3 (ADR-003, 기획서 §13).
 *
 * ## 이 값은 신뢰점수가 아니다 — 그리고 공개 DTO 에 넣지 않는다
 *
 * PROPLUS 는 단일 신뢰점수를 출시하지 않는다. 점수는 서로 비교 불가능한 직군을 한 줄로 세우고
 * (보안정책 §4.9), 그 순간 "점수 올리는 법"이 제품이 되어 검증의 의미가 사라진다.
 *
 * 그래서 이 함수의 반환값은 **본인 워크스페이스의 할 일 안내 전용**이다:
 *   - **공개 DTO 에 넣지 않는다.** `publicDto.ts` 의 `NEVER_PUBLIC_KEYS` 에 'completeness' 가
 *     들어 있어, 실수로 공개 응답에 섞이면 `assertNoPrivateKeys()` 가 테스트에서 던진다 (N-4).
 *   - **정렬·랭킹 키로 쓰지 않는다.** 검색 랭킹 근거는 `search.ts` 의 `RANKING_BASIS_CODES` 에
 *     열거된 것뿐이고 완성도는 거기에 없다 (N-15).
 *   - UI 문구도 점수처럼 읽히면 안 된다 — "신뢰도 80%"가 아니라 "프로필에서 빠진 항목"이다
 *     (P-032 수용기준: 신뢰점수로 오인될 표현 금지).
 *
 * `badgeCount` 가 입력에 있는 것은 "배지를 하나도 안 올렸다"를 알려주기 위함이고,
 * 배지가 많을수록 높은 **등급**을 주기 위함이 아니다. 그래서 항목별 가중치 없이 전부 1점이다 —
 * 가중치가 생기면 그게 곧 점수 모델이다.
 */

export interface CompletenessInput {
  hasHeadline: boolean;
  hasBio: boolean;
  specialtyCount: number;
  badgeCount: number;
  offerCount: number;
  /** 상담 CTA 가 설정됐는가. 모바일 첫 화면 요구사항(M02 수용기준)과 직접 연결된다. */
  hasCta: boolean;
}

/** 안내 항목 코드. UI 가 라벨을 붙인다 — 문구가 바뀌어도 코드는 고정이라 로그·테스트가 안정적이다. */
export const COMPLETENESS_ITEMS = ["headline", "bio", "specialties", "badges", "offers", "cta"] as const;
export type CompletenessItem = (typeof COMPLETENESS_ITEMS)[number];

/** 워크스페이스 안내 문구. 점수 어감을 피하고 "무엇을 하면 되는지"로 쓴다 (브랜드 §5). */
export const COMPLETENESS_LABEL_KO: Record<CompletenessItem, string> = {
  headline: "한 줄 소개 작성",
  bio: "상세 소개 작성",
  specialties: "전문 분야 추가",
  badges: "검증 항목 제출",
  offers: "상품·서비스 등록",
  cta: "상담 받기 버튼 설정",
};

/**
 * 빠진 항목과 그 비율. 비율은 **진행 안내**이고 품질 평가가 아니다.
 *
 * 항목이 모두 동일 가중이므로 percent 는 `채운 수 / 전체` 의 반올림이다.
 */
export function profileCompleteness(i: CompletenessInput): { percent: number; missing: string[] } {
  const done: Record<CompletenessItem, boolean> = {
    headline: i.hasHeadline === true,
    bio: i.hasBio === true,
    specialties: positive(i.specialtyCount),
    badges: positive(i.badgeCount),
    offers: positive(i.offerCount),
    cta: i.hasCta === true,
  };

  const missing: string[] = [];
  let filled = 0;
  for (const item of COMPLETENESS_ITEMS) {
    if (done[item]) filled++;
    else missing.push(item);
  }

  return {
    percent: Math.round((filled / COMPLETENESS_ITEMS.length) * 100),
    missing,
  };
}

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}
