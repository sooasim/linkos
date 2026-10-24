/**
 * P-001 매직링크 발송 — `POST /api/v1/auth/request-link`.
 *
 * 응답이 **계정 존재 여부를 말하지 않는다**: 성공·미가입·정지 모두 `{ sent }` 한 가지 모양으로 나간다
 * (보안정책 §2 계정 열거). 그래서 이 라우트에는 "그런 계정이 없습니다" 분기가 없다 —
 * 모듈도 같은 이유로 같은 값을 돌려준다.
 *
 * 한도(P-004)는 모듈이 주소 단위로 소비한다. 라우트는 IP·주소 중 무엇으로 셀지 결정하지 않는다(계층 규칙).
 */

import { identity } from "@proplus/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, setSession } from "@/lib/server";

/**
 * 길이만 본다. 형식 판정(NFKC 접기 + 정규식)은 모듈이 한 곳에서 한다 —
 * 두 곳에서 검사하면 라우트가 통과시킨 주소를 모듈이 거절하는(또는 그 반대) 틈이 생긴다.
 * 상한 254 는 RFC 5321 의 주소 최대 길이이고, 그 이상은 읽기도 전에 자른다.
 */
const Body = z.object({ email: z.string().max(254) });

export const POST = route(
  async ({ ctx, body }) => {
    const { email } = parse(Body, body);
    const out = await identity.requestLoginLink(ctx, email);

    // DEMO_LOGIN=1(개발·테스트 서버 전용) 경로는 메일 없이 바로 세션을 내준다.
    // 토큰을 **본문에 넣지 않고 쿠키로만** 심는다 — 본문에 들어가면 로그·프록시에 세션이 남는다.
    if (out.demoSessionToken) {
      return setSession(NextResponse.json({ sent: false, demo: true }), out.demoSessionToken);
    }

    // devLoginToken 은 SMTP 미설정 + 비운영에서만 모듈이 채운다(e2e 가 메일함 없이 흐름을 끝내는 값).
    return out.devLoginToken ? { sent: out.sent, devLoginToken: out.devLoginToken } : { sent: out.sent };
  },
  { auth: false },
);
