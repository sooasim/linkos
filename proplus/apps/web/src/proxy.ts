/**
 * P-042 CSP 헤더 — 요청별 nonce 발급 (N-10 보조 겹).
 *
 * ADR-011 은 Next 16.4.0 에서 nonce 가 `<script>` 에 붙지 않는다는 측정 결과로
 * `script-src 'self' 'unsafe-inline'` 을 택했다. 16.4.3 에서 고쳐진 것을 2026-10-25 에
 * 실측으로 확인해서(응답 HTML 의 `<script>` 11/11 에 nonce 가 붙는다) 이 파일을 되살렸다.
 * 덕분에 `'unsafe-inline'` 이 사라졌다 — 주입된 인라인 스크립트가 더는 실행되지 않는다.
 *
 * Next 를 올릴 때마다 `node proplus/scripts/check-csp-nonce.mjs` 로 **응답 HTML** 을 확인한다.
 * 헤더에 nonce 가 보이는 것은 동작 증거가 아니다 — ADR-011 이 그 함정에서 나왔다.
 *
 * ## 반드시 요청 헤더에 심어야 한다
 *
 * Next 는 `parseRequestHeaders()` 에서 **요청** 헤더의 `content-security-policy` 를 읽어
 * nonce 를 추출한다(`getScriptNonceFromHeader`). 응답 헤더에만 CSP 를 세팅하면
 * 렌더러는 nonce 를 보지 못하고 스크립트에 속성이 붙지 않는다 — 그래서
 * `NextResponse.next({ request: { headers } })` 로 요청 헤더를 덮어쓴다.
 * 응답 헤더에도 같은 값을 세팅해야 브라우저가 실제로 그 정책을 적용한다.
 *
 * `headers.set()` 은 **덮어쓴다**(append 가 아니다). 이게 보안상 중요하다 — Next 가 요청 헤더의
 * CSP 를 읽으므로, 클라이언트가 자기 nonce 를 담은 `content-security-policy` 요청 헤더를
 * 보내면 그 값이 쓰일 수 있다. 여기서 매 요청 덮어써서 그 경로를 닫는다.
 *
 * ## edge 런타임이라 node:crypto 를 쓸 수 없다
 *
 * 미들웨어는 edge 런타임에서 돈다. `randomBytes` 대신 `crypto.getRandomValues` 를 쓴다.
 * 16바이트(128bit)면 추측 불가하다(보안정책 §2 — 토큰은 ≥128bit).
 *
 * ## CSP 는 한 곳에서만 내려보낸다
 *
 * 헤더가 두 개면 브라우저가 **교집합**을 적용해서 조용히 더 엄해진다.
 * 이 파일이 CSP 를 보내는 동안 `next.config.ts` 는 CSP 를 보내지 않는다
 * (`next.config.ts` 의 주석 참조).
 */

import { NextResponse, type NextRequest } from "next/server";

const isDev = process.env.NODE_ENV !== "production";

/** 16바이트 난수 → base64. edge 런타임에 `Buffer` 가 없으므로 `btoa` 로 인코딩한다. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 이전에 `next.config.ts` 가 보냈던 디렉티브와 **같은 값**을 쓴다. 다른 것은 `script-src` 뿐이다:
 * `'unsafe-inline'` 대신 요청마다 바뀌는 nonce 를 쓴다(ADR-011 "갱신 2026-10-25").
 *
 * ## ⚠️ `'strict-dynamic'` 을 **일부러 쓰지 않는다** — 추가하지 마라
 *
 * `'strict-dynamic'` 이 있으면 브라우저는 `'self'` 를 **무시**한다. 그러면 nonce 가 하나라도
 * 빠진 페이지는 스크립트가 **전부** 차단된다. 그리고 이 앱에는 nonce 를 넣을 수 없는 페이지가
 * 구조적으로 둘 있다 — Next 가 빌드 시점에 굽는 `_not-found.html` · `_global-error.html` 이다.
 * 이 둘은 **의도적으로** 정적이고(서버가 죽었을 때도 떠야 한다, `scripts/check-no-prerender.mjs`
 * 가 예외로 허용한다), 구워진 HTML 에는 요청별 nonce 를 넣을 방법이 없다.
 *
 * 실측(2026-10-25, 프로덕션 빌드):
 *   - `'strict-dynamic'` 있음 → 404 페이지의 `<script>` 10개 **전부 차단**, 하이드레이션 없음
 *   - `'strict-dynamic'` 없음 → 외부 청크 7개는 `'self'` 로 정상 로드, 인라인 3개만 차단
 *
 * 그래서 `'self' 'nonce-…'` 로 둔다. 이 조합에서도 **nonce 없는 인라인 스크립트는 차단된다**
 * — N-10 이 막으려는 것(주입된 인라인 스크립트)은 그대로 막힌다. 교차출처 스크립트도 `'self'`
 * 가 막는다. 포기한 것은 "같은 출처의 스크립트 URL 주입" 차단뿐이고, 그러려면 공격자가
 * 먼저 마크업 주입 + 공격자가 제어하는 same-origin JS 경로를 둘 다 가져야 한다
 * (PROPLUS 에는 사용자가 올린 파일을 JS 로 서빙하는 경로가 없다 — 증거 파일은 signed URL 전용).
 */
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // next/font 가 @font-face 를 인라인 <style> 로 심는다. 스타일은 임의 코드 실행 경로가 아니다.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "media-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce);

  const headers = new Headers(request.headers);
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  /**
   * HTML 문서에만 걸면 된다. nonce 는 렌더되는 `<script>` 를 위한 것이고,
   * 정적 자산·이미지 최적화 응답에는 스크립트가 없다.
   * `/api` 는 JSON 이라 CSP 가 의미 없고, 매 요청 헤더를 복사하는 비용만 든다.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
