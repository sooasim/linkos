/**
 * P-163 추가 정보 요청 (`needs_more_info`).
 *
 * `{id}` 는 증거 id 다 (approve 라우트 주석 참조).
 *
 * `message` 를 필수로 받는다: "추가 정보가 필요하다"만 통지하면 당사자가 **무엇을** 올려야 하는지 모르고,
 * 그 상태의 증거는 큐에서도 사라진 채 멈춘다. 모듈은 이 문구를 `notifications` 본문에 담는다(멱등 삽입).
 * 사유 코드는 받지 않는다 — 모듈이 사유 코드를 기록하는 전이는 반려·취소뿐이다.
 *
 * N-14: 분쟁 전 단계의 문구이므로 확정적 비난 표현을 쓰지 않는다(문구 책임은 운영자에게 있고,
 * 공개 라벨은 어차피 도메인이 "확인 필요"로 고정한다).
 */

import { proof } from "@proplus/api";
import { VERIFICATION_METHODS } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  message: z.string().min(5).max(300),
  method: z.enum(VERIFICATION_METHODS).optional(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  return proof.transition(ctx, params.id, "needs_more_info", {
    message: input.message,
    ...(input.method ? { method: input.method } : {}),
  });
});
