/**
 * P-161 승인 (데이터모델 §4 `POST /admin/verifications/{id}/approve`).
 *
 * **`{id}` 는 증거 id 다.** 문서의 경로 이름은 그대로 지켰지만 식별자는 증거다:
 * `verifications` 행은 전이할 때마다 새로 생기므로(모듈 `applyTransition`) 승인 시점에
 * 가리킬 수 있는 "검증 id" 가 아직 없다. 콘솔은 `GET /admin/queue` 의 `evidenceId` 를 쓴다.
 *
 * `method` 와 `scope` 를 **필수**로 받는다:
 *  - 강도(method)의 기본값은 `self_declared` 이고 그 상태로는 verified 가 될 수 없다(N-1).
 *    즉 "모르면 통과"가 아니라 "모르면 자기기재"다 — 검증자가 무엇을 근거로 승인했는지 명시해야 한다.
 *  - 범위(scope)는 보안정책 §4.3 이 요구하고 DB CHECK 도 NOT NULL 로 막는다.
 *    "무엇이 검증되었는가"가 비면 배지는 범위 없는 보증이 된다.
 *
 * `self_declared` 를 enum 에서 빼지 않은 이유: 거부는 도메인이 `self_declared_cannot_verify` 로
 * 해야 운영자가 "정책 위반"임을 알 수 있다. 라우트가 먼저 막으면 그냥 입력 오류로 보인다(N-1 의 설명 책임).
 */

import { proof } from "@proplus/api";
import { VERIFICATION_METHODS } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  method: z.enum(VERIFICATION_METHODS),
  scope: z.string().min(1).max(200),
  /** 생략하면 유형 기본 TTL(`evidence_types.default_ttl_days`)이 적용된다 (P-062 만료). */
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
  message: z.string().max(300).nullish(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  return proof.transition(ctx, params.id, "verified", {
    method: input.method,
    scope: input.scope,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    message: input.message ?? null,
  });
});
