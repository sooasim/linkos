/**
 * P-042 CSP 헤더 · P-180 워크스페이스 (전략 §3)
 *
 * LINKOS 의 apps/web/next.config.ts 와 같은 형태지만 **CSP 와 Permissions-Policy 가 더 좁다.**
 * 이유: PROPLUS 는 미니사이트에 사용자 JS 를 허용하지 않고(N-10, 모듈명세 M03),
 * 명함 촬영·녹음 기능이 없어서 카메라·마이크를 쓸 일이 자체적으로 없다.
 * LINKOS 는 OCR(tesseract.js wasm)·녹음 때문에 wasm-unsafe-eval 과 camera=(self) 가 필요했지만
 * 여기서 같은 예외를 베껴 오면 N-10 을 지킬 수단이 사라진다.
 */

import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * N-10 / P-042 (보안정책 §2 "프로필 XSS").
 *
 * ## CSP 는 이 파일이 아니라 `src/proxy.ts` 가 보낸다
 *
 * nonce 는 **요청마다 달라야** 하므로 정적인 설정 파일에서는 만들 수 없다.
 * 디렉티브 전문과 그 근거는 `src/proxy.ts` 에 있다.
 *
 * ADR-011 은 Next 16.4.0 에서 nonce 가 `<script>` 에 붙지 않는다는 측정으로
 * `script-src 'self' 'unsafe-inline'` 을 여기서 내려보냈다. **16.4.3 에서 고쳐졌고**
 * 2026-10-25 재측정으로 확인해서(ADR-011 "갱신 2026-10-25") CSP 를 `proxy.ts` 로 옮겼다:
 * `script-src 'self' 'nonce-<요청별>'` — 인라인 스크립트가 더는 열려 있지 않다.
 * (`'strict-dynamic'` 은 **일부러 빼 두었다** — 이유는 `proxy.ts` 주석과 ADR-011 갱신 절.)
 *
 * ⚠️ **CSP 를 여기서 다시 보내지 마라.** 헤더가 두 개면 브라우저가 둘의 **교집합**을 적용해서
 * 조용히 더 엄해진다 — `proxy.ts` 의 nonce 와 여기의 `'unsafe-inline'` 이 겹치면
 * 교집합에서 둘 다 살아남지 못하는 조합이 생긴다. nginx vhost 도 공통 스니펫을 include 하지 않는다
 * (`infra/nginx` 주석 참조). CSP 를 내려보내는 곳은 **`proxy.ts` 한 곳**이고
 * `architecture.test.ts` 가 그것을 강제한다.
 *
 * ## N-10 은 CSP 혼자 지키지 않는다
 *
 * CSP 는 N-10 의 **마지막 겹**이다. nonce 가 돌아왔어도 1차 방어선은 그대로 코드 쪽이고,
 * 모두 테스트가 있다 — CSP 가 또 한 번 프레임워크 사정으로 약해져도 N-10 은 유지된다:
 *   1. `blockSchema.ts` allowlist — 임의 HTML 을 **저장할 경로 자체가 없다** (P-040)
 *   2. `sanitizeText()` — 태그·javascript: 스킴·엔티티 다중 인코딩 제거 (P-041)
 *   3. React 자동 이스케이프 — 보간된 문자열은 HTML 로 파싱되지 않는다
 *   4. `dangerouslySetInnerHTML`·`eval`·`new Function` 금지 —
 *      `services/api/test/architecture.test.ts` 가 소스를 훑어 **기계적으로** 막는다
 *
 * ## 되돌리거나 또 깨졌을 때
 *
 * `'strict-dynamic'` 은 `'self'` 를 **무시**한다. nonce 가 하나라도 빠지면
 * `/_next/static/chunks/*.js` 까지 전부 차단되는데, 서버는 200 을 주고 SSR 마크업도 정상이라
 * **빌드·타입체크·테스트가 전부 통과한다.** 그래서 Next 를 올릴 때마다
 * `node proplus/scripts/check-csp-nonce.mjs` 로 **응답 HTML 의 `<script>` 를 확인한다.**
 * 그 검사가 실패하면 `proxy.ts` 의 `script-src` 를 `'self' 'unsafe-inline'` 으로 되돌리고
 * ADR-011 에 측정값을 남긴다.
 */

/**
 * 기능 권한은 전부 끈다. PROPLUS 의 증거 제출은 **파일 업로드**이고(모듈명세 M04),
 * 기기 센서를 직접 켜는 경로가 없다. 나중에 누가 카메라를 쓰려면 이 줄을 고쳐야 하고,
 * 그 PR 에서 "왜 센서가 필요한가"를 설명하게 된다.
 */
const permissionsPolicy = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "bluetooth=()",
  "serial=()",
  "display-capture=()",
  "midi=()",
].join(", ");

const securityHeaders = [
  // Content-Security-Policy 는 **의도적으로 여기 없다** — `src/proxy.ts` 가 요청별 nonce 와 함께
  // 보낸다(위 주석 참조). 다시 추가하면 CSP 헤더가 두 개가 되어 교집합이 적용된다.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: permissionsPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const noStore = [
  { key: "Cache-Control", value: "no-store" },
];

const config: NextConfig = {
  output: "standalone",
  /**
   * `next dev`·`next build` 의 업그레이드 알림 정책. 'security' 는 Next 의 기본값이기도 하지만
   * **명시해 둔다** — 기본값이 바뀌어도 이 저장소는 "보안 권고가 있을 때만 알린다"에 머문다.
   * 'latest'·'experimental-future' 는 보안과 무관한 메이저·마이너 업그레이드까지 권하므로 쓰지 않는다.
   * 이 옵션은 스스로 업그레이드하지 않는다(알림 정책만 정한다).
   */
  experimental: { agentUpgrade: "security" },
  // 배포 단위는 proplus/ 만이 아니라 저장소 루트 node_modules 를 공유한다 (전략 §1 "공유하는 것").
  //
  // `new URL(...).pathname` 을 쓰면 Windows 에서 `/E:/linkos/...` 가 나오고(앞에 슬래시가 붙은 드라이브 문자)
  // Next 가 그 경로를 canonicalize 하지 못해 빌드가 os error 123 으로 죽는다.
  // `fileURLToPath` 는 플랫폼에 맞는 경로를 돌려준다.
  outputFileTracingRoot: fileURLToPath(new URL("../../../", import.meta.url)),
  transpilePackages: ["@proplus/domain", "@proplus/api"],
  serverExternalPackages: ["pg", "nodemailer"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      /**
       * N-9 (보안정책 §4.5): 만료·취소된 배지는 즉시 사라져야 한다.
       * 공개 프로필을 CDN·브라우저가 캐시하면 "회수된 배지가 남아 보이는" 창이 생기고,
       * 그것은 읽기 시점 만료 판정(public_profile_view)을 무의미하게 만든다.
       */
      { source: "/p/:path*", headers: noStore },
      { source: "/api/:path*", headers: noStore },
      /**
       * 증거 원본 접근 경로. signed URL 과 파일 식별자가 Referer 로 새어 나가면
       * 짧은 TTL 의 의미가 사라진다 (보안정책 §2 "증빙 파일 유출").
       *
       * ⚠️ 경로를 바꿀 때 **실제 라우트와 맞는지 확인하라.** 이전 값은 `/api/v1/evidence/:path*`
       *    였고 그런 라우트는 없어서(실제는 `/api/v1/me/evidence/...`) 이 헤더가 아무것도
       *    덮지 않았다. 매칭되지 않는 보안 헤더는 있는 것처럼 보이면서 없는 것과 같다.
       */
      { source: "/api/v1/me/evidence/:path*", headers: [...noStore, { key: "Referrer-Policy", value: "no-referrer" }] },
      // 서명 URL 본체(`/api/v1/files?key=&exp=&sig=`)와 발급 경로. 핸들러도 같은 헤더를 직접 붙이지만
      // (route.ts), 설정과 코드 양쪽에 두어 한쪽을 지워도 남게 한다.
      { source: "/api/v1/files", headers: [...noStore, { key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/api/v1/files/:path*", headers: [...noStore, { key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default config;
