/**
 * P-052 / P-073 — 서명 URL 로 증거 원본 바이트를 내려보내는 **유일한** 경로.
 *
 * 왜 이 파일이 따로 필요한가:
 *   `lib/storage.ts` 의 `getSignedUrl()` 은 `/api/v1/files?key=…&exp=…&sig=…` 를 만든다.
 *   `/api/v1/files/[id]` 는 그 **URL 을 발급**하고(권한·접근사유 확인 + 감사로그), 실제 바이트는
 *   여기서 나간다. 이 핸들러가 없으면 발급된 모든 서명 URL 이 404 이고 `verifySignedUrl()` 은
 *   호출되는 곳이 없다 — 즉 증거 다운로드 기능 전체가 죽는다.
 *
 * 보안 경계 (보안정책 §2 "증빙 파일 유출"):
 *   - **세션을 보지 않는다.** 서명 자체가 자격증명이다. 그래서 TTL 이 60초로 짧고(N-5),
 *     발급 시점에 이미 권한·접근사유를 확인하고 감사로그를 남겼다(P-073).
 *     여기서 세션을 다시 보면, 서명을 받은 사용자가 로그아웃한 뒤 열지 못해 운영이 막히고,
 *     반대로 보안이 더 세지지도 않는다 — 서명 없이는 어차피 못 연다.
 *   - 서명 검증을 통과하지 못하면 **403 이 아니라 404** 다. 키의 존재 여부를 알려 주지 않는다.
 *   - `route()` 를 쓰지 않는다: 이 응답은 JSON 이 아니고 세션 회전도 필요 없다.
 *     origin 검사도 불필요하다(GET 이고 쿠키를 읽지 않으므로 CSRF 가 성립하지 않는다).
 */

import { getObject, log, verifySignedUrl } from "@proplus/api";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** 브라우저가 증거 파일을 인라인 렌더하지 않게 한다 — PDF·SVG 안의 스크립트 실행 경로를 없앤다. */
const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, no-cache, must-revalidate, private",
  "x-content-type-options": "nosniff",
  // 서명이 쿼리스트링에 있으므로 Referer 로 새 나가면 그 자체가 유출이다.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; sandbox",
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const key = req.nextUrl.searchParams.get("key");
  const exp = req.nextUrl.searchParams.get("exp");
  const sig = req.nextUrl.searchParams.get("sig");

  if (!key || !exp || !sig) return notFound();

  if (!verifySignedUrl({ key, exp, sig })) {
    // 만료와 위조를 구분해 알려 주지 않는다. 다만 운영자가 "링크가 자꾸 죽는다"를 진단할 수 있게
    // 서버 로그에는 남긴다 — key 는 추측 불가능한 난수이므로 PII 가 아니다 (N-13).
    log("warn", "files.signature_rejected", { key, exp });
    return notFound();
  }

  let bytes: Buffer;
  try {
    bytes = await getObject(key);
  } catch {
    return notFound();
  }

  // content-type 을 저장하지 않고 고정값을 쓴다: 선언 유형을 그대로 돌려주면
  // 업로더가 'image/svg+xml' 로 선언한 파일이 브라우저에서 스크립트로 실행될 수 있다.
  // 유형별 렌더링이 필요하면 발급 라우트(`/api/v1/files/[id]`)가 메타데이터로 알려 준다.
  const body = new Uint8Array(bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...DOWNLOAD_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength),
      "content-disposition": "attachment",
    },
  });
}

function notFound(): NextResponse {
  return NextResponse.json({ code: "not_found", message: "파일을 찾을 수 없습니다." }, { status: 404, headers: DOWNLOAD_HEADERS });
}
