/**
 * P-005 기기별 세션 폐기 — `DELETE /api/v1/me/sessions/{id}`.
 *
 * id 형식을 라우트에서 따로 검사하지 않는다: 모듈의 UPDATE 에 `user_id` 조건이 있어 남의 id 는
 * 0행이 되고 404 가 되며, uuid 가 아닌 값은 `mapInputError()` 가 404 로 접는다(db.ts 주석).
 * 즉 "존재하지만 내 것이 아닌 id" 와 "없는 id" 가 같은 응답이라 세션 id 탐색이 불가능하다.
 */

import { identity } from "@proplus/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => identity.revokeSession(ctx, params.id));
