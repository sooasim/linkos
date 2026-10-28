/**
 * P-166 이의제기 큐 (보안정책 §4.6).
 *
 * `?status=` 는 모듈에 그대로 넘긴다. 기본값은 `open` 이고 `all` 이면 전체다 —
 * 라우트가 상태 집합을 따로 정의하면 `appeals.status` CHECK 제약과 두 벌이 된다.
 * 처리 경과 시간(`openHours`)이 함께 오므로 콘솔은 SLA 초과 건을 정렬 없이도 가려낼 수 있다.
 */

import { admin } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => ({
  items: await admin.listAppeals(ctx, req.nextUrl.searchParams.get("status") ?? "open"),
}));
