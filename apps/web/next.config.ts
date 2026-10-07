import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// tesseract.js loads its worker/wasm/language data from jsDelivr on demand (on-device OCR).
// Google Identity Services (F-060 One Tap, only rendered on /login and /claim when GOOGLE_CLIENT_ID is set).
const gsi = "https://accounts.google.com/gsi/";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net ${gsi}client${isDev ? " 'unsafe-eval'" : ""}`,
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  `connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com ${gsi} data: blob:`,
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
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@linkos/domain", "@linkos/api"],
  serverExternalPackages: ["pg", "exceljs", "nodemailer"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // exchange links carry a bearer token in the path: never send it as a referrer
      { source: "/x/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/c/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // org invite links carry a bearer token too (F-004)
      { source: "/join/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
      // NFC tag landing: redirects to a fresh one-time exchange token
      { source: "/n/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      { source: "/.well-known/apple-app-site-association", headers: [{ key: "Content-Type", value: "application/json" }] },
      { source: "/.well-known/assetlinks.json", headers: [{ key: "Content-Type", value: "application/json" }] },
    ];
  },
};

export default config;
