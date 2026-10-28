/**
 * route() — 라우트 핸들러 래퍼.
 *
 * 책임은 LINKOS 의 apps/web/src/lib/server.ts 와 같다 (전략 §3 "라우트는 얇은 어댑터"):
 *   ctx 구성 → 변경요청 origin 검사(CSRF) → 세션 회전 → Idempotency-Key 재생 → 에러 규격화.
 * 비즈니스 분기와 SQL 은 여기 들어오지 않는다. 모듈(@proplus/api)이 한다.
 *
 * 쿠키 이름이 LINKOS 와 다른 것이 설계다 (전략 §1 "공유하지 않는 것: 세션 쿠키").
 * proplus.linkos.com 과 linkos.ckp.kr 을 같은 브라우저에서 쓰는 사람이 흔할 것이고,
 * 이름이 겹치면 한쪽 로그인이 다른 쪽을 덮어쓴다. 그래서 pp_* 접두사를 쓴다.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  type Ctx,
  identity,
  idempotencyLookup,
  idempotencyStore,
  isValidIdempotencyKey,
  log,
  mapInputError,
} from "@proplus/api";
import { generateToken, hashToken, isAllowedOrigin } from "@proplus/domain";
import { cookies, headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export const SESSION_COOKIE = "pp_session";
export const ANON_COOKIE = "pp_anon";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export function cookieOptions(maxAge = SESSION_MAX_AGE) {
  return {
    httpOnly: true,
    // 로컬 개발(http://localhost:4400)에서는 secure 쿠키가 저장되지 않으므로 배포 출처로 판단한다.
    secure: (process.env.APP_ORIGIN ?? "").startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function clientIp(h: Headers): string {
  // nginx 가 X-Forwarded-For 를 붙인다 (배포 런북 §vhost). 첫 홉이 실제 클라이언트다.
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "0.0.0.0").trim();
}

/** Server Component 용 읽기 전용 인증. 여기서는 쿠키를 쓸 수 없으므로 세션 회전도 하지 않는다. */
export async function getViewer(): Promise<{ userId: string | null; ctx: Ctx }> {
  const h = await headers();
  const c = await cookies();
  const session = await identity.resolveSession(
    c.get(SESSION_COOKIE)?.value,
    { userAgent: h.get("user-agent") ?? "" },
    false,
  );
  const ctx: Ctx = {
    userId: session?.userId ?? null,
    sessionId: session?.sessionId ?? null,
    ip: clientIp(h),
    userAgent: h.get("user-agent") ?? "",
    requestId: randomUUID(),
  };
  return { userId: ctx.userId, ctx };
}

type Handler<P> = (args: { req: NextRequest; ctx: Ctx; params: P; body: unknown }) => Promise<unknown | NextResponse>;

interface RouteOptions {
  /** 기본값은 "로그인 필요". 공개 경로(/p/[slug], 상담 폼)는 명시적으로 false 를 적는다. */
  auth?: boolean;
  status?: number;
}

export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOptions = {}) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<NextResponse> => {
    const requestId = randomUUID();
    let rotated: string | undefined;
    try {
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);

      if (mutating) {
        // CSRF: SameSite=lax 는 top-level GET 만 막는다. 쓰기는 출처를 직접 확인한다 (보안정책 §2).
        const origin = req.headers.get("origin");
        const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
        if (!isAllowedOrigin(origin, host, process.env.APP_ORIGIN)) {
          throw new ApiError(403, "bad_origin", "허용되지 않은 요청 출처입니다.");
        }
      }

      const userAgent = req.headers.get("user-agent") ?? "";
      // P-002: 세션 토큰은 매 요청 회전한다 — 유출된 토큰의 유효 창을 좁히기 위해서다.
      const session = await identity.resolveSession(req.cookies.get(SESSION_COOKIE)?.value, { userAgent }, true);
      rotated = session?.rotatedToken;

      const ctx: Ctx = {
        userId: session?.userId ?? null,
        // 회전 전 세션 행 id. 토큰은 이미 회전됐지만 id 는 그대로다 — "지금 이 기기"를 가리키는 유일한 값이다.
        sessionId: session?.sessionId ?? null,
        ip: clientIp(req.headers),
        userAgent,
        requestId,
      };
      if (opts.auth !== false && !ctx.userId) throw new ApiError(401, "unauthorized", "로그인이 필요합니다.");

      let body: unknown = undefined;
      if (mutating) {
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          body = await req.json().catch(() => {
            throw new ApiError(400, "invalid_json", "JSON 본문을 해석할 수 없습니다.");
          });
        } else if ((req.headers.get("content-length") ?? "0") !== "0") {
          // 폼 전송(application/x-www-form-urlencoded)은 cross-site 로 보낼 수 있으므로 받지 않는다.
          throw new ApiError(415, "unsupported_media_type", "application/json 만 허용됩니다.");
        }
      }

      const params = (await context.params) ?? ({} as P);

      // CLAUDE.md §3 / 데이터모델 §5: 모든 create/update 는 Idempotency-Key 를 지원한다.
      // 증거 제출·리드 생성은 모바일 네트워크에서 재시도가 흔하고, 두 번 실행되면
      // 검토 큐에 중복 항목이 생기거나 같은 상담 요청이 두 건으로 쌓인다.
      const rawKey = mutating ? req.headers.get("idempotency-key") : null;
      const idemKey = isValidIdempotencyKey(rawKey) ? rawKey : null;
      let idemScope: string | null = null;
      if (idemKey) {
        // 비로그인 호출자(공개 상담 폼)도 재생 대상이다. 익명 쿠키가 없으면 ip|ua 해시로 범위를 좁힌다.
        const anon = req.cookies.get(ANON_COOKIE)?.value ?? `${ctx.ip}|${userAgent}`;
        const who = ctx.userId ?? `anon:${hashToken(anon).slice(0, 32)}`;
        idemScope = `route:${who}:${req.method}:${req.nextUrl.pathname}`;
        const hit = await idempotencyLookup<unknown>(idemScope, idemKey, body ?? null);
        if (hit) {
          const replay = NextResponse.json(hit.body, { status: hit.status });
          replay.headers.set("idempotent-replayed", "true");
          replay.headers.set("x-request-id", requestId);
          applyRotatedSession(replay, rotated);
          return replay;
        }
      }

      const out = await handler({ req, ctx, params, body });
      const res = out instanceof NextResponse ? out : NextResponse.json(out ?? { ok: true }, { status: opts.status ?? 200 });

      // Set-Cookie 가 붙은 응답(로그인 등)은 재생하지 않는다 — 다른 사람에게 같은 세션을 줄 수 있다.
      if (
        idemScope &&
        idemKey &&
        res.status >= 200 &&
        res.status < 300 &&
        !res.headers.get("set-cookie") &&
        (res.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const cached = out instanceof NextResponse ? await res.clone().json().catch(() => undefined) : (out ?? { ok: true });
        if (cached !== undefined) {
          await idempotencyStore(idemScope, idemKey, body ?? null, res.status, cached).catch((e: unknown) =>
            log("warn", "idempotency.store_failed", { error: (e as Error).message }),
          );
        }
      }

      applyRotatedSession(res, rotated);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (e) {
      const res = errorResponse(e, requestId);
      applyRotatedSession(res, rotated);
      return res;
    }
  };
}

/**
 * 에러 응답 규격 (데이터모델 §5): { code, message, traceId, details? }.
 * 내부 stack trace 는 응답에 넣지 않는다 (전략 §7 로그 정책) — traceId 로 서버 로그를 찾는다.
 */
/**
 * 회전된 세션 토큰을 응답에 싣는다 — **핸들러가 세션을 직접 심지 않았을 때만.**
 *
 * 왜 조건이 필요한가: `ResponseCookies.set` 은 같은 이름의 쿠키를 교체한다. 그래서 조건 없이
 * 덮으면 `auth/callback`(로그인) 처럼 **새 세션을 심는 라우트**에서, 이미 로그인된 사용자가
 * 호출했을 때 방금 발급한 쿠키가 **옛 세션의 회전 토큰으로 되돌아간다.** 증상은 "계정 전환이
 * 안 된다" 이고, 로그인 자체는 200 으로 성공하므로 원인을 찾기 어렵다.
 *
 * 핸들러가 `setSession()`·`clearSession()` 을 호출했으면 그쪽 의도가 우선이다.
 */
function applyRotatedSession(res: NextResponse, rotated: string | undefined): void {
  if (!rotated) return;
  if (res.cookies.get(SESSION_COOKIE)) return;
  res.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
}

export function errorResponse(e: unknown, traceId: string): NextResponse {
  // 잘못된 uuid/날짜가 Postgres 까지 내려가 터진 경우는 500 이 아니라 클라이언트 입력 오류다.
  const mapped = mapInputError(e);
  if (mapped !== e) return errorResponse(mapped, traceId);

  if (e instanceof ApiError) {
    const res = NextResponse.json(
      { code: e.code, message: e.message, traceId, details: e.details ?? undefined },
      { status: e.status },
    );
    const retryAfter = (e.details as { retryAfter?: number } | undefined)?.retryAfter;
    if (e.status === 429 && retryAfter) res.headers.set("retry-after", String(retryAfter));
    return res;
  }

  if (e instanceof ZodError) {
    return NextResponse.json(
      {
        code: "validation_failed",
        message: "입력값을 확인하세요.",
        traceId,
        details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  log("error", "api.unhandled", {
    traceId,
    error: (e as Error)?.message,
    stack: (e as Error)?.stack?.split("\n").slice(0, 4).join(" | "),
  });
  return NextResponse.json({ code: "internal_error", message: "일시적인 오류가 발생했습니다.", traceId }, { status: 500 });
}

export function parse<T>(schema: ZodType<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

export function setSession(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE, token, cookieOptions());
  return res;
}

export function clearSession(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}

/**
 * 비로그인 방문자의 1st-party 식별자. 조회 집계(P-130)와 rate limit 버킷에만 쓴다.
 * 값 자체는 랜덤 토큰이고 PII 가 아니다 (N-13).
 */
export function anonId(req: NextRequest): { id: string; fresh: boolean } {
  const v = req.cookies.get(ANON_COOKIE)?.value;
  return v ? { id: v, fresh: false } : { id: generateToken(16), fresh: true };
}

export function withAnon(res: NextResponse, a: { id: string; fresh: boolean }): NextResponse {
  if (a.fresh) res.cookies.set(ANON_COOKIE, a.id, { ...cookieOptions(60 * 60 * 24 * 365) });
  return res;
}

/** route() 를 쓸 수 없는 핸들러(스트리밍 응답 등)가 같은 ctx 를 만들 때 쓴다. */
export function requestCtx(req: NextRequest): Ctx {
  return {
    userId: null,
    sessionId: null,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent") ?? "",
    requestId: randomUUID(),
  };
}

/** open redirect 방지: 로그인 후 돌아갈 곳은 같은 출처의 경로여야 한다. */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
