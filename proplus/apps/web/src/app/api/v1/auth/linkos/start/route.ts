/**
 * LINKOS 단일 로그인 — `GET /api/v1/auth/linkos/start`(시작) · `POST`(완료).
 *
 * 근거: `proplus/docs/05_LINKOS_INTEGRATION.md` §1 (흐름 1~6, state)
 *
 * ## 왜 한 파일에 GET 과 POST 가 같이 있는가
 *
 * 둘은 **같은 하나의 로그인**의 양끝이고, 둘을 잇는 것은 `pp_sso_state` 쿠키 하나다. 쿠키 이름·TTL·
 * 속성이 두 파일로 흩어지면 한쪽만 바뀌는 사고가 난다(그 사고의 증상은 "로그인이 전부
 * state 불일치"다). 그래서 상수를 공유하는 한 파일에 둔다.
 *
 * ## 왜 GET 이 토큰을 소비하지 않는가
 *
 * GET 은 **아무것도 소비하지 않는다** — state 를 만들고 LINKOS 로 보내기만 한다. assertion 소비는
 * `/login/linkos` 화면이 사용자 브라우저에서 POST 로 한다. `auth/callback` 라우트 주석과 같은 이유다:
 * GET 으로 토큰을 소비하면 링크 프리뷰·보안 스캐너가 먼저 열어 1회성 토큰을 태우고, 그 스캐너에게
 * 유효한 세션이 발급된다. POST 는 래퍼의 출처 검사(CSRF)도 함께 받는다.
 *
 * ## 연동이 꺼져 있으면 404
 *
 * `SSO_SHARED_SECRET`·`LINKOS_BASE_URL` 이 비면 이 엔드포인트는 **없는 것처럼** 행동한다 (05 §5).
 * 503 이 아니라 404 인 이유: 503 은 "있는데 지금 안 된다"는 뜻이고, 클라이언트가 재시도한다.
 */

import { ApiError, linkosSso } from "@proplus/api";
import { constantTimeEqual, generateToken } from "@proplus/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cookieOptions, parse, route, safeNext, setSession } from "@/lib/server";

/**
 * 로그인 CSRF 차단용 state (05 §1). `pp_` 접두사는 LINKOS 쿠키와 섞이지 않게 하는 저장소 관례다
 * (전략 §1 · architecture.test.ts "세션 쿠키 이름이 LINKOS 와 겹치지 않는다").
 */
const SSO_STATE_COOKIE = "pp_sso_state";

/**
 * 5분. assertion 자체는 60초만 살지만, state 는 **LINKOS 에서 로그인하는 시간**까지 버텨야 한다
 * (05 §1 흐름 3: 비로그인이면 LINKOS 로그인을 먼저 끝내고 돌아온다). 그래도 짧게 둔다 —
 * 오래 살면 공격자가 미리 심어 둔 state 로 피해자를 자기 계정에 로그인시킬 창이 넓어진다.
 */
const SSO_STATE_TTL_SEC = 5 * 60;

function unavailableHere(): ApiError {
  return new ApiError(404, "not_found", "LINKOS 계정 로그인을 사용할 수 없습니다.");
}

/** 05 §1 흐름 1~2: state 를 심고 LINKOS 인증 화면으로 보낸다. */
export const GET = route(
  async () => {
    if (!linkosSso.linkosSsoEnabled()) throw unavailableHere();

    // 128bit 랜덤(CLAUDE.md §5). 서버만 아는 값을 쿠키에 두고 복귀 시 대조하는 것이 state 의 전부다.
    const state = generateToken(16);
    const res = NextResponse.redirect(linkosSso.authorizeUrl(state), 302);
    // httpOnly: 이 값이 스크립트로 읽히면 LINKOS 로 보낸 state 와 대조하는 의미가 없어진다.
    res.cookies.set(SSO_STATE_COOKIE, state, cookieOptions(SSO_STATE_TTL_SEC));
    return res;
  },
  { auth: false },
);

const Body = z.object({
  /** `v1.<payload>.<sig>`. 길이 상한은 도메인의 `SSO_ASSERTION_MAX_LEN` 과 같다. */
  assertion: z.string().min(20).max(4096),
  /** GET 이 심은 쿠키와 대조할 값. base64url 22자(16바이트)이므로 하한을 16으로 둔다. */
  state: z.string().min(16).max(256),
});

/** 05 §1 흐름 5~6: assertion 을 검증·소비하고 `pp_session` 을 발급한다. */
export const POST = route(
  async ({ req, ctx, body }) => {
    if (!linkosSso.linkosSsoEnabled()) throw unavailableHere();
    const { assertion, state } = parse(Body, body);

    // 로그인 CSRF: 공격자가 **자기** LINKOS assertion 을 피해자 브라우저로 보내 피해자를
    // 공격자 계정에 로그인시키는 공격을 막는다. 그 요청에는 우리가 심은 state 쿠키가 없다.
    const expected = req.cookies.get(SSO_STATE_COOKIE)?.value ?? "";
    if (expected.length === 0 || !constantTimeEqual(expected, state)) {
      throw new ApiError(400, "sso_state_mismatch", "로그인 요청을 확인할 수 없습니다. 처음부터 다시 시도해 주세요.");
    }

    // 세션을 발급할 수 없는 배포에서는 **소비하기 전에** 끊는다 — 소비해 버리면 jti 가 타고
    // 계정만 연결된 채 로그인은 안 되는 상태가 남고, 사용자는 같은 링크로 다시 시도할 수 없다.
    // (근거: modules/linkosSso.ts `issueSsoSession` 주석의 TODO)
    if (!linkosSso.ssoSessionIssuable()) {
      throw new ApiError(
        503,
        "sso_session_unavailable",
        "LINKOS 계정 로그인을 지금 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    }

    const { userId, isNew } = await linkosSso.consumeAssertion(ctx, assertion);
    const issued = await linkosSso.issueSsoSession({ ...ctx, userId }, userId);

    const res = NextResponse.json({
      userId: issued.userId,
      expiresAt: issued.expiresAt,
      isNew,
      // 이동 경로를 **요청에서 받지 않는다.** 복귀 URL 의 쿼리는 LINKOS 쪽이 채우는 값이라
      // 거기서 받으면 open redirect 의 입구가 LINKOS 로 옮겨 가는 것뿐이다.
      next: safeNext(null),
    });
    // state 는 1회성이다. 성공했으면 비워서 같은 값으로 두 번째 교환을 시도할 수 없게 한다.
    res.cookies.set(SSO_STATE_COOKIE, "", cookieOptions(0));
    return setSession(res, issued.sessionToken);
  },
  { auth: false },
);
