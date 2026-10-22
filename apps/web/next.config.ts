import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// tesseract.js loads its worker/wasm/language data from jsDelivr on demand (on-device OCR).
// Google Identity Services (F-060 One Tap, only rendered on /login and /claim when GOOGLE_CLIENT_ID is set).
const gsi = "https://accounts.google.com/gsi/";

// 배포처가 HTML 에 스크립트를 주입하는 경우를 위한 탈출구(기본값 없음 — 기본 CSP 는 그대로 엄격하다).
// 예) linkos.ckp.kr 은 Cloudflare 프록시 뒤에 있고 zone 전역 Web Analytics 가
//     static.cloudflareinsights.com/beacon.min.js 를 모든 HTML 에 주입한다. 허용하지 않으면
//     화면은 정상 동작하지만 콘솔이 CSP 위반으로 계속 더럽혀진다.
//     공백으로 구분한 출처 목록을 빌드 시점에 넣는다(헤더는 빌드 결과에 박힌다).
const extra = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? ` ${v}` : "";
};

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net ${gsi}client${isDev ? " 'unsafe-eval'" : ""}${extra("CSP_EXTRA_SCRIPT_SRC")}`,
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  `connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com ${gsi} data: blob:${extra("CSP_EXTRA_CONNECT_SRC")}`,
  `frame-src ${gsi}`,
  "img-src 'self' data: blob:",
  `style-src 'self' 'unsafe-inline' ${gsi}style`,
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const config: NextConfig = {
  output: "standalone",
  // fileURLToPath (not URL.pathname): on Windows `.pathname` yields "/E:/…" which Turbopack cannot canonicalize.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@linkos/domain", "@linkos/api"],
  serverExternalPackages: ["pg", "exceljs", "nodemailer", "sharp", "@aws-sdk/client-s3", "pdfkit", "web-push"],
  // F-126: the PDF export embeds Pretendard from node_modules
  outputFileTracingIncludes: { "/api/v1/exports/**": ["./node_modules/pretendard/dist/public/static/alternative/Pretendard-{Regular,SemiBold}.ttf"], "/api/v1/integrations/google/drive": ["./node_modules/pretendard/dist/public/static/alternative/Pretendard-{Regular,SemiBold}.ttf"] },
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // exchange links carry a bearer token in the path: never send it as a referrer
      { source: "/x/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/c/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // X-009 문자로 보낸 명함 링크도 경로에 토큰이 있다
      { source: "/s/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // org invite links carry a bearer token too (F-004)
      { source: "/join/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/b/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
      // NFC tag landing: redirects to a fresh one-time exchange token
      { source: "/n/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/.well-known/apple-app-site-association", headers: [{ key: "Content-Type", value: "application/json" }] },
      { source: "/.well-known/assetlinks.json", headers: [{ key: "Content-Type", value: "application/json" }] },
    ];
  },
};

export default config;
