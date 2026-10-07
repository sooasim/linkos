import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// tesseract.js loads its worker/wasm/language data from jsDelivr on demand (on-device OCR).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net${isDev ? " 'unsafe-eval'" : ""}`,
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com data: blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
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
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@linkos/domain", "@linkos/api"],
  serverExternalPackages: ["pg", "exceljs", "nodemailer", "sharp", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // exchange links carry a bearer token in the path: never send it as a referrer
      { source: "/x/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/c/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
      { source: "/.well-known/apple-app-site-association", headers: [{ key: "Content-Type", value: "application/json" }] },
    ];
  },
};

export default config;
