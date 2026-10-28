/**
 * P-123 예약 취소 — 데이터모델 §4 (`POST /me/appointments/{id}/cancel`).
 *
 * ## `auth: true` 인 이유 (IDOR)
 *
 * 경로가 `/me/...` 인 것이 설계다. 모듈 주석이 분명히 말한다: `appointments` 에는 토큰 컬럼이 없어서
 * **게스트 취소 경로를 열면 uuid 를 아는 누구나 남의 예약을 취소할 수 있다.** 그래서 지금은 방문자의
 * 취소 요청을 소유자가 대신 반영하고, `by='visitor'` 로 "누가 요청했는지"만 감사로그에 남긴다.
 *
 * `by` 는 **권한이 아니라 기록**이다. 권한 판정은 언제나 프로필 소유자 세션으로 한다(모듈이 한다).
 */

import { booking } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * `CancelActor` 는 모듈이 **타입으로만** 내보낸다(런타임 상수 배열이 없다). 그래서 리터럴을 여기에
 * 적었고, 집합이 바뀌면 타입 오류로 드러난다 — 모듈이 어떤 값이 와도 `owner` 로 정규화하므로
 * 이 enum 은 "잘못된 값을 조용히 owner 로 바꾸지 않고 400 으로 알려 주기" 위한 것이다.
 */
const cancelBody = z.strictObject({
  by: z.enum(["owner", "visitor", "system"]).optional(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const { by } = parse(cancelBody, body);
  return { appointment: await booking.cancelAppointment(ctx, params.id, by) };
});

// TODO(P-125 와 함께): `appointment_tokens` 추가 마이그레이션 후 게스트 취소 링크용 공개 경로
//   (`POST /public/appointments/{token}/cancel`)를 연다. 토큰 없이는 열지 않는다.
