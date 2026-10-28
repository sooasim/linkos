/**
 * P-171 감사 추적 조회 (N-6·N-7: 모든 상태 변경이 남고, 그 기록은 append-only 다).
 *
 * `aggregateType` 을 **필수**로 받는다: 조건 없는 전체 감사로그 조회는 "운영자 내부 오남용"
 * (보안정책 §2)의 가장 쉬운 형태이고, 화면에서도 쓸 수 없는 양이다. 집계가 필요하면 KPI 를 쓴다.
 * `aggregateId` 를 함께 주면 한 리소스의 이력만 나온다 — 콘솔의 정상 사용 형태다.
 */

import { admin } from "@proplus/api";
import { z } from "zod";
import { route } from "@/lib/server";

const Query = z.object({
  aggregateType: z.string().min(2).max(60),
  aggregateId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  const qs = Query.parse({
    aggregateType: sp.get("type") ?? undefined,
    aggregateId: sp.get("id") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  return { items: await admin.auditTrail(ctx, qs.aggregateType, qs.aggregateId ?? null, qs.limit) };
});
