/**
 * P-168 이의제기 처리 (보안정책 §4.6·§4.7).
 *
 * `outcome` 은 번복률 집계의 입력이다: `upheld` = 원 결정 유지 / `overturned` = 번복.
 * 두 값만 받는 것은 집계가 "처리됨" 같은 중립 라벨로 흐려지지 않게 하려는 것이다(P-168 번복률).
 *
 * `decision` 은 **생략 가능**하고, 생략하면 모듈이 기본값을 쓴다:
 *   overturned → `under_review`(재심)  ·  upheld → 분쟁 전 결정 복원.
 * 그래서 이 라우트는 키를 **보낸 것만** 넘긴다 — 모듈이 `decision.scope === undefined` 로
 * "지정 안 함"과 "비우라는 지시(null)"를 구분하기 때문에, 빈 값을 null 로 채워 보내면 복원이 깨진다.
 *
 * 상태 변경은 전부 `proof.transition()` 을 거친다(모듈 책임) — N-1 관문을 우회하는 두 번째 경로를 만들지 않는다.
 */

import { admin } from "@proplus/api";
import { VERIFICATION_METHODS } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  outcome: z.enum(["upheld", "overturned"]),
  resolution: z.string().min(5).max(2000),
  decision: z
    .object({
      to: z.enum(["verified", "rejected", "under_review"]).optional(),
      method: z.enum(VERIFICATION_METHODS).optional(),
      scope: z.string().max(200).nullish(),
      reasonCode: z.string().min(2).max(60).nullish(),
      expiresAt: z.iso.datetime({ offset: true }).nullish(),
    })
    .optional(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  const d = input.decision;
  const decision = {
    ...(d?.to !== undefined ? { to: d.to } : {}),
    ...(d?.method !== undefined ? { method: d.method } : {}),
    ...(d?.scope !== undefined ? { scope: d.scope } : {}),
    ...(d?.reasonCode !== undefined ? { reasonCode: d.reasonCode } : {}),
    ...(d?.expiresAt !== undefined ? { expiresAt: d.expiresAt === null ? null : new Date(d.expiresAt) } : {}),
  };
  return admin.resolveAppeal(ctx, params.id, input.outcome, input.resolution, decision);
});
