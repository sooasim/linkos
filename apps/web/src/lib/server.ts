import "server-only";
import { randomUUID } from "node:crypto";
import { ApiError, type Ctx, identity, log, recordRequest, routeKey, tracing } from "@linkos/api";
import { generateToken } from "@linkos/domain";
import { cookies, headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export const SESSION_COOKIE = "lk_session";
export const ANON_COOKIE = "lk_anon";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export function cookieOptions(maxAge = SESSION_MAX_AGE) {
  return { httpOnly: true, secure: (process.env.APP_ORIGIN ?? "").startsWith("https:"), sameSite: "lax" as const, path: "/", maxAge };
}

function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "0.0.0.0").trim();
}

/** Read-only auth for Server Components (no cookie rotation possible here). */
export async function getViewer(): Promise<{ userId: string | null; ctx: Ctx }> {
  const h = await headers();
  const c = await cookies();
  const s = await identity.resolveSession(c.get(SESSION_COOKIE)?.value, { userAgent: h.get("user-agent") ?? "" }, false);
  const ctx: Ctx = { userId: s?.userId ?? null, ip: clientIp(h), userAgent: h.get("user-agent") ?? "", requestId: randomUUID() };
  return { userId: ctx.userId, ctx };
}

/** Native apps (apps/mobile, App Clip) send `Authorization: Bearer <token>`; such tokens only resolve native sessions. */
export function bearerToken(req: NextRequest): string | undefined {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h.trim()) : null;
  return m?.[1];
}

/** Resolve the caller's session from the bearer header (native) or the session cookie (web). */
export async function resolveRequestSession(req: NextRequest, rotate: boolean) {
  const ua = req.headers.get("user-agent") ?? "";
  const bearer = bearerToken(req);
  if (bearer) return { session: await identity.resolveSession(bearer, { userAgent: ua }, false, "native"), bearer: true };
  return { session: await identity.resolveSession(req.cookies.get(SESSION_COOKIE)?.value, { userAgent: ua }, rotate), bearer: false };
}

type Handler<P> =(args: { req: NextRequest; ctx: Ctx; params: P; body: unknown }) => Promise<unknown | NextResponse>;

interface RouteOptions {
  auth?: boolean;
  status?: number;
}

/**
 * Route handler wrapper: builds request context, rotates the session cookie (F-007),
 * enforces same-origin + JSON for mutations (CSRF), and maps errors to the OpenAPI Error schema.
 */
export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOptions = {}) {
  const inner = handle(handler, opts);
  // F-180: server span per request (W3C traceparent in/out). No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<NextResponse> => {
    if (!tracing.tracingEnabled()) return inner(req, context);
    const key = routeKey(req.method, req.nextUrl.pathname);
    return tracing.withSpan(
      key,
      { "http.request.method": req.method, "http.route": key },
      async (span) => {
        const res = await inner(req, context);
        span?.setAttribute("http.response.status_code", res.status);
        if (res.status >= 500) span?.recordError(`HTTP ${res.status}`);
        if (span) res.headers.set("traceparent", tracing.formatTraceparent(span));
        return res;
      },
      { kind: "server", traceparent: req.headers.get("traceparent") },
    );
  };
}

function handle<P>(handler: Handler<P>, opts: RouteOptions) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<NextResponse> => {
    const requestId = randomUUID();
    const started = performance.now();
    const key = routeKey(req.method, req.nextUrl.pathname);
    let rotated: string | undefined;
    try {
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (mutating) {
        const origin = req.headers.get("origin");
        const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
        if (origin && host && new URL(origin).host !== host) throw new ApiError(403, "bad_origin", "허용되지 않은 요청 출처입니다.");
      }
      const ua = req.headers.get("user-agent") ?? "";
      const { session } = await resolveRequestSession(req, true);
      rotated = session?.rotatedToken;
      const ctx: Ctx = { userId: session?.userId ?? null, ip: clientIp(req.headers), userAgent: ua, requestId };
      if (opts.auth !== false && !ctx.userId) throw new ApiError(401, "unauthorized", "로그인이 필요합니다.");
      let body: unknown = undefined;
      if (mutating) {
        const ct = req.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) body = await req.json().catch(() => {
          throw new ApiError(400, "invalid_json");
        });
        else if ((req.headers.get("content-length") ?? "0") !== "0") throw new ApiError(415, "unsupported_media_type", "application/json 만 허용됩니다.");
      }
      const params = (await context.params) ?? ({} as P);
      const out = await handler({ req, ctx, params, body });
      const res = out instanceof NextResponse ? out : NextResponse.json(out ?? { ok: true }, { status: opts.status ?? 200 });
      if (rotated) res.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
      res.headers.set("x-request-id", requestId);
      recordRequest(key, res.status, performance.now() - started);
      return res;
    } catch (e) {
      const res = errorResponse(e, requestId);
      recordRequest(key, res.status, performance.now() - started);
      if (rotated) res.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
      return res;
    }
  };
}

export function errorResponse(e: unknown, traceId: string) {
  if (e instanceof ApiError) {
    const res = NextResponse.json({ code: e.code, message: e.message, traceId, details: e.details ?? undefined }, { status: e.status });
    if (e.status === 429 && (e.details as { retryAfter?: number })?.retryAfter) res.headers.set("retry-after", String((e.details as { retryAfter: number }).retryAfter));
    return res;
  }
  if (e instanceof ZodError) {
    return NextResponse.json({ code: "validation_failed", message: "입력값을 확인하세요.", traceId, details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  }
  log("error", "api.unhandled", { traceId, error: (e as Error)?.message, stack: (e as Error)?.stack?.split("\n").slice(0, 4).join(" | ") });
  return NextResponse.json({ code: "internal_error", message: "일시적인 오류가 발생했습니다.", traceId }, { status: 500 });
}

export function parse<T>(schema: ZodType<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

export function setSession(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, cookieOptions());
  return res;
}

/** Anonymous first-party id (httpOnly cookie) for flags/experiments/analytics of signed-out visitors. */
export function anonId(req: NextRequest): { id: string; fresh: boolean } {
  const v = req.cookies.get(ANON_COOKIE)?.value;
  return v ? { id: v, fresh: false } : { id: generateToken(16), fresh: true };
}

export function withAnon(res: NextResponse, a: { id: string; fresh: boolean }) {
  if (a.fresh) res.cookies.set(ANON_COOKIE, a.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365, secure: (process.env.APP_ORIGIN ?? "").startsWith("https:") });
  return res;
}

export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
