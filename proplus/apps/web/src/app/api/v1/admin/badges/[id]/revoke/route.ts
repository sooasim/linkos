/**
 * P-061 배지 취소 (사유 코드 필수 · 공개 배지 즉시 제거 · 감사로그).
 *
 * `{id}` 는 배지 id 다. 모듈은 배지만 내리지 않고 **검증 자체를 `revoked` 로 전이**한다 —
 * 둘이 갈라지면 "취소된 배지인데 검증은 유효" 같은 상태가 생긴다. 전이는 같은 관문(`canTransition`)을 지난다.
 *
 * N-9: 공개 반영은 같은 트랜잭션에서 일어나고, 만료 판정은 읽기 시점이다. 배치를 기다리는 창이 없다.
 */

import { proof } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({ reasonCode: z.string().min(2).max(60) });

export const POST = route<{ id: string }>(async ({ ctx, params, body }) =>
  proof.revokeBadge(ctx, params.id, parse(Body, body).reasonCode),
);
