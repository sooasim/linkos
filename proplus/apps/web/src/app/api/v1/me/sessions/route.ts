/**
 * P-005 세션 목록 — `GET /api/v1/me/sessions`
 * P-003 전체 세션 폐기 — `DELETE /api/v1/me/sessions`
 *
 * 목록은 모듈이 `user_id` 조건으로만 조회한다(IDOR 차단). 라우트는 범위를 넓힐 인자를 받지 않는다.
 */

import { identity } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ sessions: await identity.listSessions(ctx) }));

/**
 * P-003 "계정 탈취 대응으로 모든 세션을 한 번에 폐기".
 *
 * **대상 사용자를 본문에서 받지 않는다.** 모듈은 타인 세션 폐기를 지원하지만 그 경로는
 * `admin.access` + 접근 사유(P-165)를 요구하는 운영 행위이고, 운영 콘솔 라우트가 담당한다.
 * 여기서 userId 를 받으면 사유 없는 타인 세션 폐기 경로가 본인용 엔드포인트에 생긴다.
 */
export const DELETE = route(async ({ ctx }) => identity.revokeAllSessions(ctx, undefined, { reason: "owner_request" }));
