/**
 * P-170 신고 처리 — "조치와 사유를 감사로그에 남긴다"(수용기준).
 *
 * 이 라우트는 **결정만** 기록한다. 대상 리소스를 고치는 것은 다른 모듈의 일이다(모듈 간 테이블 쓰기 금지):
 *   프로필 비공개 → `profile` 모듈 · 배지 취소 → `POST /admin/badges/{id}/revoke`.
 * 그래서 콘솔은 보통 두 번 호출한다(조치 실행 → 신고 종결). 한 번에 묶지 않는 이유는
 * 조치의 책임 주체(어느 모듈이 무엇을 바꿨는가)를 감사로그에서 섞지 않으려는 것이다.
 *
 * `action` 집합은 `reports.status` CHECK 제약(`open` 제외)과 같다.
 */

import { admin } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  action: z.enum(["in_review", "actioned", "dismissed"]),
  reason: z.string().min(3).max(1000),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const input = parse(Body, body);
  return admin.handleReport(ctx, params.id, input.action, input.reason);
});
