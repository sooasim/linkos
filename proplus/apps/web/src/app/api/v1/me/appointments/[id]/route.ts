/**
 * P-123 예약 확인 — 프로필 소유자가 `requested` 예약을 `confirmed` 로 올린다.
 *
 * ## 왜 `status` 를 하나만 받는가
 *
 * 모듈에는 확인(`confirmAppointment`)과 취소(`cancelAppointment`)만 있고, 취소는 데이터모델 §4 가
 * 정한 별도 경로(`POST /me/appointments/{id}/cancel`)를 쓴다. 그래서 이 PATCH 가 받을 수 있는 값은
 * `confirmed` 뿐이다. `completed`·`no_show` 를 임의로 열면 라우트가 모듈에 없는 상태 전환을
 * 발명하는 셈이 된다 — 전환 규칙은 모듈과 DB CHECK 가 소유한다.
 *
 * 되살리기(`canceled → confirmed`)는 모듈이 막는다: 취소된 줄 알았던 시간에 두 건이 생기면
 * 겹침 배타 제약(P-122)과 충돌한다.
 */

import { booking } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const appointmentPatchBody = z.strictObject({ status: z.literal("confirmed") });

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => {
  parse(appointmentPatchBody, body);
  return { appointment: await booking.confirmAppointment(ctx, params.id) };
});

// TODO(P-123): `completed`·`no_show` 기록은 모듈 함수가 생긴 뒤에 여기에 더한다.
//   예약 종료 후 상태는 노쇼 정책·환불 요건과 함께 결정된다 (미결정 §2).
