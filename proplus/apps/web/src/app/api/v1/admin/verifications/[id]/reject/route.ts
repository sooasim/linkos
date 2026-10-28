/**
 * P-161 / P-162 반려 (데이터모델 §4 `POST /admin/verifications/{id}/reject` — **사유 코드 필수**).
 *
 * `{id}` 는 증거 id 다 (approve 라우트의 주석과 같은 이유).
 *
 * 사유 코드를 필수로 받는 것이 문서의 명시 요구사항이다. 코드 **목록**은 여기서 정하지 않는다 —
 * 반려 사유 분류는 첫 파일럿 직군이 정해진 뒤 운영이 채우는 값이고(미결정 §2 / 전략 §8),
 * 모양(소문자·숫자·`_.:-`)만 모듈이 검사한다. 자유 문장이 코드 컬럼에 들어가면 집계가 깨지고
 * 당사자에게 보일 문구가 코드에 섞인다.
 *
 * `message` 는 당사자 통지에 붙는 안내다. N-14: 분쟁 가능성이 있는 단계이므로 확정적 비난 표현을 쓰지 않는다.
 */

import { proof } from "@proplus/api";
import { VERIFICATION_METHODS } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  reasonCode: z.string().min(2).max(60),
  /** 어떤 강도로 들여다본 끝에 반려했는지를 기록에 남긴다. 생략하면 직전 검증의 강도를 쓴다. */
  method: z.enum(VERIFICATION_METHODS).optional(),
  message: z.string().max(300).nullish(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  return proof.transition(ctx, params.id, "rejected", {
    reasonCode: input.reasonCode,
    ...(input.method ? { method: input.method } : {}),
    message: input.message ?? null,
  });
});
