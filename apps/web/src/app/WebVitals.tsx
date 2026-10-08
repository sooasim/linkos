"use client";
// 백서 §20 RUM: real-user LCP/INP/CLS (+FCP/TTFB) via next/web-vitals → sendBeacon to /api/v1/vitals.
// Sampled (NEXT_PUBLIC_RUM_SAMPLE_RATE, default 0.25); only the pathname is sent and the server reduces it to a route
// pattern (/x/[token]) — no query string, token, user id or other PII. Renders nothing; no extra dependency.
import { useReportWebVitals } from "next/web-vitals";

const RATE = Number(process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE ?? "0.25");
const sampled = typeof window !== "undefined" && RATE > 0 && Math.random() < Math.min(1, RATE);
const WANTED = new Set(["LCP", "INP", "CLS", "FCP", "TTFB"]);

export function WebVitals() {
  useReportWebVitals((m) => {
    if (!sampled || !WANTED.has(m.name)) return;
    const body = JSON.stringify([{ name: m.name, value: m.value, rating: m.rating, navigationType: m.navigationType, path: location.pathname }]);
    try {
      if (!navigator.sendBeacon?.("/api/v1/vitals", body)) {
        void fetch("/api/v1/vitals", { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => undefined);
      }
    } catch {
      /* RUM is best effort */
    }
  });
  return null;
}
