import "server-only";
// Binary upload route wrapper (sibling of route() which is JSON-only). Same auth, session rotation, origin check
// and error mapping; the raw body is streamed with a hard byte cap. CORS-safelisted content types
// (multipart/form-data, text/plain, x-www-form-urlencoded) are refused so a cross-site <form> can never upload.
import { randomUUID } from "node:crypto";
import { ApiError, type Ctx, identity, recordRequest, routeKey, sha256, withIdempotency } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, cookieOptions, errorResponse } from "./server";

type UploadHandler<P> = (args: { req: NextRequest; ctx: Ctx; params: P; bytes: Buffer; contentType: string; filename: string | null; search: URLSearchParams }) => Promise<unknown>;

const SAFELISTED = /^(multipart\/form-data|text\/plain|application\/x-www-form-urlencoded)/i;

async function readCapped(req: NextRequest, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new ApiError(413, "file_too_large", "파일이 너무 큽니다.");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "file_too_large", "파일이 너무 큽니다.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function uploadRoute<P = Record<string, string>>(handler: UploadHandler<P>, opts: { maxBytes: number; status?: number; idempotencyScope?: string }) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    const requestId = randomUUID();
    const started = performance.now();
    const key = routeKey(req.method, req.nextUrl.pathname);
    let rotated: string | undefined;
    try {
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (origin && host && new URL(origin).host !== host) throw new ApiError(403, "bad_origin", "허용되지 않은 요청 출처입니다.");
      const contentType = (req.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
      if (SAFELISTED.test(contentType)) throw new ApiError(415, "unsupported_media_type", "파일 원본(binary)으로 업로드하세요.");
      const ua = req.headers.get("user-agent") ?? "";
      const session = await identity.resolveSession(req.cookies.get(SESSION_COOKIE)?.value, { userAgent: ua });
      rotated = session?.rotatedToken;
      const ctx: Ctx = { userId: session?.userId ?? null, ip: (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "0.0.0.0").trim(), userAgent: ua, requestId };
      if (!ctx.userId) throw new ApiError(401, "unauthorized", "로그인이 필요합니다.");
      const bytes = await readCapped(req, opts.maxBytes);
      const params = (await context.params) ?? ({} as P);
      const rawName = req.headers.get("x-file-name");
      let filename: string | null = null;
      try {
        filename = rawName ? decodeURIComponent(rawName).replace(/[\\/\r\n"]/g, "_").slice(0, 200) : null;
      } catch {
        filename = null;
      }
      const run = async () => ({ status: opts.status ?? 201, body: await handler({ req, ctx, params, bytes, contentType, filename, search: req.nextUrl.searchParams }) });
      const idem = req.headers.get("idempotency-key");
      const out = opts.idempotencyScope
        ? await withIdempotency(`${opts.idempotencyScope}:${ctx.userId}:${req.nextUrl.pathname}`, idem, { sha: sha256(bytes.toString("base64")), q: req.nextUrl.search }, run)
        : await run();
      const res = NextResponse.json(out.body ?? { ok: true }, { status: out.status });
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

/** Binary download response for decrypted files (never cached, never sniffed, PDFs sandboxed). */
export function fileResponse(o: { bytes: Buffer; contentType: string; filename: string | null }, download = false) {
  const name = o.filename ?? "file";
  return new NextResponse(new Uint8Array(o.bytes), {
    status: 200,
    headers: {
      "content-type": o.contentType,
      "content-length": String(o.bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "content-disposition": `${download || o.contentType === "application/pdf" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "referrer-policy": "no-referrer",
    },
  });
}
