/**
 * P-052 / P-196 증거 파일 업로드 (보안정책 §2 "업로드 악성 파일 · MIME sniffing · 크기 제한").
 *
 * 두 개의 메서드가 한 쌍이다:
 *   GET  — 바이트를 보내기 **전에** 유형·상태·형식·크기·개수를 거절하는 사전검사(세션).
 *          서버 상태를 만들지 않으므로 GET 이다. 지금 스토리지는 로컬 드라이버라 presigned PUT URL 이 없고,
 *          S3 드라이버가 들어오면 모듈만 presign 을 돌려주면 된다(모듈 주석 / 전략 §6).
 *   POST — 실제 바이트. `route()` 를 쓰지 않는다: 래퍼는 `application/json` 만 받고
 *          그 밖의 content-type 을 415 로 끊는다. 그래서 래퍼가 하는 일을 이 파일이 **같은 순서로** 직접 한다:
 *          출처 검사(CSRF) → 세션 회전 → 인증 → Idempotency-Key 재생 → 에러 규격화 → 세션 쿠키 재설정.
 *
 * 파일명 취급(N-13): 모듈은 파일명을 저장하지 않는다. 그래서
 *   - GET 사전검사는 파일명을 받지 않는다(쿼리스트링은 접근로그에 남는다).
 *   - POST 는 multipart 의 `file` 필드에 실려 온 이름만 **확장자 교차검증용으로** 넘기고 그대로 버린다.
 *   - raw 업로드에는 파일명 경로를 두지 않는다 — 헤더로 받으면 그 값이 프록시 로그에 남는다.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  type Ctx,
  identity,
  idempotencyLookup,
  idempotencyStore,
  isValidIdempotencyKey,
  log,
  proof,
} from "@proplus/api";
import { MAX_EVIDENCE_BYTES, isAllowedOrigin } from "@proplus/domain";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, clientIp, cookieOptions, errorResponse, route } from "@/lib/server";

// 업로드는 캐시 대상이 아니고, 사전검사 결과도 "지금 상태"에 달려 있다.
export const dynamic = "force-dynamic";

/**
 * multipart 봉투 여유분. 본문 전체를 메모리에 읽기 전에 선언 길이로 먼저 끊는다 —
 * 10MB 한도(`MAX_EVIDENCE_BYTES`)를 통과하지 못할 요청에 10MB 를 할당할 이유가 없다.
 */
const MAX_ENVELOPE_BYTES = MAX_EVIDENCE_BYTES + 64 * 1024;

const SessionQuery = z.object({
  declaredMime: z.string().min(3).max(120),
  byteSize: z.coerce.number().int().positive(),
});

export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const sp = req.nextUrl.searchParams;
  const meta = SessionQuery.parse({
    declaredMime: sp.get("mime") ?? undefined,
    byteSize: sp.get("size") ?? undefined,
  });
  return proof.createUploadSession(ctx, params.id, meta);
});

/** content-type 의 파라미터(`; charset=`, `; boundary=`)를 떼고 소문자로 맞춘다. */
function baseType(raw: string | null): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  let rotated: string | undefined;
  try {
    // CSRF: SameSite=lax 는 top-level GET 만 막는다. 쓰기는 출처를 직접 확인한다 (보안정책 §2).
    // multipart 는 폼으로 cross-site 전송이 가능하므로 이 검사가 JSON 경로보다 더 중요하다.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!isAllowedOrigin(origin, host, process.env.APP_ORIGIN)) {
      throw new ApiError(403, "bad_origin", "허용되지 않은 요청 출처입니다.");
    }

    const userAgent = req.headers.get("user-agent") ?? "";
    // P-002: 세션 토큰은 매 요청 회전한다. 업로드 경로만 예외를 두면 그 창으로 오래된 토큰이 살아남는다.
    const session = await identity.resolveSession(req.cookies.get(SESSION_COOKIE)?.value, { userAgent }, true);
    rotated = session?.rotatedToken;
    const ctx: Ctx = {
      userId: session?.userId ?? null,
      sessionId: session?.sessionId ?? null,
      ip: clientIp(req.headers),
      userAgent,
      requestId,
    };
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "로그인이 필요합니다.");

    /**
     * content-length 를 필수로 요구한다. 길이를 모르는 chunked 본문은 한도를 **읽어 본 뒤에야** 알 수 있고,
     * 그 사이 메모리는 이미 쓰인다. 브라우저의 fetch 는 Blob·FormData 본문에 길이를 붙이므로
     * 정상 클라이언트가 막히지 않는다.
     */
    const lengthHeader = req.headers.get("content-length");
    if (!lengthHeader || !/^\d+$/.test(lengthHeader.trim())) {
      throw new ApiError(411, "content_length_required", "본문 길이(content-length)를 포함해야 합니다.");
    }
    if (Number(lengthHeader) > MAX_ENVELOPE_BYTES) {
      throw new ApiError(413, "file_too_large", `파일은 ${Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024))}MB 이하여야 합니다.`);
    }

    const contentType = baseType(req.headers.get("content-type"));
    let bytes: Buffer;
    let declaredMime: string;
    let filename: string | undefined;

    if (contentType === "multipart/form-data") {
      const form = await req.formData();
      const part = form.get("file");
      if (typeof part === "string" || part === null) {
        throw new ApiError(400, "file_required", "file 필드에 파일을 담아 보내세요.");
      }
      bytes = Buffer.from(await part.arrayBuffer());
      // 선언 MIME 은 업로더의 **주장**이다. 모듈이 매직바이트와 교차검증해 다르면 거부한다.
      declaredMime = baseType(part.type) || "application/octet-stream";
      filename = part.name || undefined;
    } else {
      /**
       * raw 업로드. `application/octet-stream` 은 "형식을 말하지 않았다"는 뜻이므로
       * 실제 유형은 `x-file-content-type` 으로 선언받는다. 그 밖의 content-type 은 그 자체가 선언이다.
       * 어느 쪽이든 모듈의 `validateUpload()` 가 매직바이트와 맞춰 보고 다르면 거부한다.
       */
      bytes = Buffer.from(await req.arrayBuffer());
      declaredMime =
        contentType === "application/octet-stream" || contentType === ""
          ? baseType(req.headers.get("x-file-content-type")) || "application/octet-stream"
          : contentType;
    }

    /**
     * CLAUDE.md §5: 모든 create API 는 Idempotency-Key 를 지원한다.
     * 재생 판정의 요청 지문은 **바이트 해시**다 — 같은 키로 다른 파일을 보내는 것은 재시도가 아니라
     * 클라이언트 버그이고, 그걸 재생으로 처리하면 올리지도 않은 파일의 id 를 받는다(409 로 끊긴다).
     */
    const fingerprint = {
      evidenceId: (await context.params).id,
      declaredMime,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const rawKey = req.headers.get("idempotency-key");
    const idemKey = isValidIdempotencyKey(rawKey) ? rawKey : null;
    const idemScope = idemKey ? `route:${ctx.userId}:POST:${req.nextUrl.pathname}` : null;

    if (idemKey && idemScope) {
      const hit = await idempotencyLookup<unknown>(idemScope, idemKey, fingerprint);
      if (hit) {
        const replay = NextResponse.json(hit.body, { status: hit.status });
        replay.headers.set("idempotent-replayed", "true");
        replay.headers.set("x-request-id", requestId);
        if (rotated) replay.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
        return replay;
      }
    }

    const out = await proof.attachFile(ctx, fingerprint.evidenceId, bytes, declaredMime, filename);

    if (idemKey && idemScope) {
      await idempotencyStore(idemScope, idemKey, fingerprint, 201, out).catch((e: unknown) =>
        log("warn", "idempotency.store_failed", { error: (e as Error).message }),
      );
    }

    const res = NextResponse.json(out, { status: 201 });
    res.headers.set("x-request-id", requestId);
    if (rotated) res.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
    return res;
  } catch (e) {
    const res = errorResponse(e, requestId);
    if (rotated) res.cookies.set(SESSION_COOKIE, rotated, cookieOptions());
    return res;
  }
}
