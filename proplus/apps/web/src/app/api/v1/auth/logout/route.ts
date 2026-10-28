/**
 * P-003 / P-005 로그아웃 — `POST /api/v1/auth/logout`.
 *
 * **이 기기의 세션만 폐기한다.** `ctx.sessionId` 가 "지금 이 요청의 세션 행 id" 를 담는다
 * (lib/ctx.ts 참조). 토큰이 아니라 id 인 이유: `route()` 가 핸들러보다 먼저 토큰을 회전시키지만
 * 회전은 **같은 행을 UPDATE** 하므로 id 는 바뀌지 않는다.
 *
 * 전체 폐기(`revokeAllSessions`)는 로그아웃이 아니라 **계정 탈취 대응**이고
 * `DELETE /me/sessions` 가 담당한다 — 휴대폰에서 로그아웃했다고 데스크톱이 끊기면
 * 사용자는 그것을 사고로 받아들인다.
 *
 * `auth: false` 인 이유: 이미 만료·폐기된 쿠키로 들어온 로그아웃이 401 이 되면
 * 클라이언트가 쿠키를 지울 기회를 잃는다. 로그아웃은 멱등해야 한다.
 */

import { ApiError, identity } from "@proplus/api";
import { NextResponse } from "next/server";
import { clearSession, route } from "@/lib/server";

export const POST = route(
  async ({ ctx }) => {
    // 세션이 없으면 지울 것도 없다. 쿠키만 비우고 같은 응답을 돌려준다.
    if (!ctx.userId || !ctx.sessionId) {
      return clearSession(NextResponse.json({ ok: true, revoked: 0 }));
    }

    try {
      await identity.revokeSession(ctx, ctx.sessionId);
      return clearSession(NextResponse.json({ ok: true, revoked: 1 }));
    } catch (e) {
      // 다른 탭이 먼저 로그아웃했거나 다른 기기에서 전체 폐기가 돌았다면 이미 없는 행이다.
      // 그건 성공과 구별할 이유가 없다 — 멱등성을 지키고 쿠키를 비운다.
      if (e instanceof ApiError && e.status === 404) {
        return clearSession(NextResponse.json({ ok: true, revoked: 0 }));
      }
      throw e;
    }
  },
  { auth: false },
);
