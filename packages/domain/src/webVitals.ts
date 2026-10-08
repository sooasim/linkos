// 백서 §20 RUM — real-user web vitals (LCP/INP/CLS…) for SLOs such as "Guest landing LCP p75 < 2.5s on 4G".
// Pure logic: route normalization (no tokens/ids/PII ever stored), sample validation, sampling. No I/O.

export const GUEST_LANDING_ROUTE = "/x/[token]";
export const GUEST_LANDING_LCP_TARGET_MS = 2500;
export const VITAL_METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];
export const VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;
export type VitalRating = (typeof VITAL_RATINGS)[number];

/** Public routes whose 2nd segment is a secret/identifier (exchange token, short code, claim/booking/invite token, slug). */
const PARAM_ROUTES: Record<string, string> = { x: "[token]", b: "[token]", c: "[code]", r: "[code]", join: "[token]", n: "[tagId]", p: "[slug]" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SEG = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Map a browser pathname to a low-cardinality route pattern. Query/hash are dropped; known parameter routes and any
 * id-, token- or number-like segment become placeholders; anything else unexpected becomes "[x]". Max 6 segments.
 */
export function normalizeVitalsRoute(pathname: string): string {
  const path = String(pathname ?? "").split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean).slice(0, 6);
  if (!segs.length) return "/";
  const out: string[] = [];
  segs.forEach((raw, i) => {
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      s = raw;
    }
    if (i === 1 && PARAM_ROUTES[out[0] ?? ""]) out.push(PARAM_ROUTES[out[0]!]!);
    else if (UUID.test(s)) out.push("[id]");
    else if (/^\d+$/.test(s)) out.push("[n]");
    else if (SAFE_SEG.test(s)) out.push(s);
    else out.push(s.length >= 16 ? "[token]" : "[x]");
  });
  return `/${out.join("/")}`;
}

export interface VitalSample {
  route: string;
  metric: VitalMetric;
  value: number;
  rating: VitalRating;
  navType: string | null;
}

const NAV_TYPES = new Set(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"]);
const MAX_VALUE: Record<VitalMetric, number> = { LCP: 120_000, INP: 60_000, CLS: 100, FCP: 120_000, TTFB: 120_000 };

/** Validate one beacon entry; returns null for anything malformed or out of range (dropped silently). */
export function parseVitalSample(x: unknown): VitalSample | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const metric = o.name ?? o.metric;
  if (typeof metric !== "string" || !(VITAL_METRICS as readonly string[]).includes(metric)) return null;
  const value = Number(o.value);
  if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE[metric as VitalMetric]) return null;
  const rating = typeof o.rating === "string" && (VITAL_RATINGS as readonly string[]).includes(o.rating) ? (o.rating as VitalRating) : null;
  if (!rating) return null;
  if (typeof o.path !== "string" || o.path.length > 512) return null;
  const navType = typeof o.navigationType === "string" && NAV_TYPES.has(o.navigationType) ? o.navigationType : null;
  return { route: normalizeVitalsRoute(o.path), metric: metric as VitalMetric, value: Math.round(value * 1000) / 1000, rating, navType };
}

/** Client sampling decision (rate 0..1); `rand` injectable for tests. */
export function shouldSampleVitals(rate: number, rand: () => number = Math.random): boolean {
  return rate > 0 && rand() < Math.min(1, rate);
}
