/**
 * P-001/P-002 매직링크 → 세션 — `POST /api/v1/auth/callback`.
 *
 * **GET 을 두지 않는다.** 메일 링크는 페이지(`identity.LOGIN_LINK_PATH` = `/login/verify`)로 가고,
 * 그 페이지가 사용자 행동 뒤에 이 엔드포인트를 호출한다. GET 으로 토큰을 소비하면
 * 메일 스캐너·안티바이러스·링크 프리뷰가 먼저 열어 (a) 1회성 토큰을 태워 사용자가 못 들어가고,
 * (b) 그 스캐너에게 `Set-Cookie` 로 **유효한 세션**이 발급된다 (보안정책 §2 계정 탈취).
 * POST 는 래퍼의 출처 검사(CSRF)도 함께 받으므로 다른 사이트가 피해자를 임의 계정으로
 * 로그인시키는 login-CSRF 도 막힌다.
 *
 * 세션 쿠키 속성(httpOnly·sameSite=lax·secure)은 `setSession()` 한 곳에만 있다.
 */

import { identity } from "@proplus/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, safeNext, setSession } from "@/lib/server";

const Body = z.object({
  // 토큰은 base64url 32바이트(≥128bit)다. 하한은 모듈과 같은 20자로 두고 상한으로 쓸모없는 긴 입력을 막는다.
  token: z.string().min(20).max(512),
  /** 로그인 후 돌아갈 경로. `safeNext()` 가 같은 출처의 경로만 통과시킨다(open redirect 방지). */
  next: z.string().max(512).optional(),
});

export const POST = route(
  async ({ ctx, body }) => {
    const { token, next } = parse(Body, body);
    const issued = await identity.consumeLoginLink(ctx, token, { userAgent: ctx.userAgent });

    const res = NextResponse.json({
      userId: issued.userId,
      expiresAt: issued.expiresAt,
      // 이동은 클라이언트가 한다. 서버가 302 로 보내면 토큰 소비와 리다이렉트가 한 요청에 묶여
      // 위 주석의 프리페치 문제가 그대로 돌아온다.
      next: safeNext(next),
    });
    return setSession(res, issued.sessionToken);
  },
  { auth: false },
);
