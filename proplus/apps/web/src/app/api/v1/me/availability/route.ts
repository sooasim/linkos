/**
 * P-120 가용 시간 · P-141 요금제 한도 — 내 주간 가용 패턴 조회·교체.
 *
 * ## PUT 인 이유
 *
 * 모듈의 `setAvailability` 는 주간 패턴을 **통째로 교체**한다(부분 수정이 겹치는 규칙을 남겨 중복
 * 슬롯을 만든다 — `booking.ts` 주석). 전체 교체 의미는 PATCH 가 아니라 PUT 이다.
 *
 * ## 요금제 `booking` 플래그를 여기서 보는 이유 (P-141)
 *
 * 한도 판정은 M10(`billing`)의 것이고 가용 시간 계산은 M08(`booking`)의 것이다. 예약 가능 여부가
 * booking 모듈 **안에서** 결제 상태에 따라 갈라지면 가용 시간 계산과 과금이 한 함수에 섞인다
 * (`booking.ts` 주석이 명시적으로 거부한다). 두 모듈을 조립하는 자리는 라우트다.
 *
 * 쓰기만 막고 읽기(GET)는 막지 않는다 — 요금제를 내린 사용자가 자기가 전에 넣은 규칙을 보지도 못하면
 * 왜 예약이 안 열리는지 화면이 설명할 수 없다.
 */

import { billing, booking, conflict } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * 값 범위(0~1440분, weekday 0~6, 슬롯 길이)는 모듈이 `normalizeRule()` 에서 자기 에러 코드로 거부한다.
 * 여기서 같은 범위를 다시 적지 않는다 — 배열 길이 상한만 하드 바운드로 둔다(본문 폭주 차단).
 * `MAX_AVAILABILITY_RULES`(50) 초과는 모듈이 `too_many_rules` 로 응답한다.
 */
const availabilityBody = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        weekday: z.number().int(),
        startMin: z.number().int(),
        endMin: z.number().int(),
        timezone: z.string().min(1).max(64),
        slotMinutes: z.number().int().optional(),
      }),
    )
    .max(200),
});

export const GET = route(async ({ ctx }) => ({ rules: await booking.getAvailability(ctx) }));

export const PUT = route(async ({ ctx, body }) => {
  const plan = await billing.planLimitsFor(ctx);
  if (!plan.limits.booking) {
    throw conflict("plan_limit", "현재 요금제에는 예약 기능이 포함되지 않습니다.", {
      planCode: plan.planCode,
      feature: "booking",
    });
  }

  const { rules } = parse(availabilityBody, body);
  return { rules: await booking.setAvailability(ctx, rules) };
});

// TODO(P-120): 예외일(휴무일)은 `availability_rules` 로 표현되지 않는다. 테이블 추가 마이그레이션이
//   선행 조건이고, 그 전에는 라우트에 임시 필드를 두지 않는다(저장할 곳이 없으면 받지 않는다).
// TODO(P-141): 공개 슬롯·예약 요청 경로는 **프로필 소유자의** 요금제를 봐야 하지만
//   `planLimitsFor(ctx)` 는 호출자 기준이다. 게스트 경로에서 소유자 요금제를 묻는 함수가 생기면
//   `/public/profiles/{slug}/slots` 에도 같은 게이트를 건다.
