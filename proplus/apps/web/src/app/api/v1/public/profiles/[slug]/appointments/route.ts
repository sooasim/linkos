/**
 * P-121 예약 요청 · P-122 이중 예약 방지 · P-094 상품→상담→예약 연결 —
 * 데이터모델 §4 (`POST /public/profiles/{slug}/appointments`).
 *
 * `auth: false` 다. 예약을 하려면 먼저 가입해야 하는 구조를 만들지 않는다.
 *
 * rate limit 은 **모듈이** 건다(`consumeLimit('lead.create', userId ?? ip)`) — 비회원 쓰기 경로의
 * 예산은 상담 요청과 같은 버킷이어야 하고, 그 버킷 선택은 M08 의 판단이다. 라우트에서 한 번 더
 * 소비하면 같은 행위가 두 예산을 깎는다.
 *
 * `Idempotency-Key` 는 `route()` 래퍼가 처리한다. 모바일 네트워크에서 예약 전송 재시도는 흔하고,
 * 두 번 실행되면 같은 사람이 같은 슬롯을 두 건 잡거나 409 를 보게 된다 (CLAUDE.md §5).
 */

import { booking } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * `startAt` 은 문자열로 받고 **파싱은 모듈에 맡긴다**. 슬롯 격자 검증(가용 규칙·초 단위·DST)이
 * Postgres 쪽에 있고, 여기서 ISO 형식만 따로 판정하면 "형식은 맞지만 슬롯이 아닌 시각"에 대해
 * 두 곳이 다른 에러 코드를 돌려준다.
 */
const appointmentBody = z.strictObject({
  startAt: z.string().min(1).max(64),
  leadId: z.uuid().nullable().optional(),
});

export const POST = route<{ slug: string }>(
  async ({ ctx, params, body }) => ({
    appointment: await booking.requestAppointment(ctx, params.slug, parse(appointmentBody, body)),
  }),
  { auth: false, status: 201 },
);
