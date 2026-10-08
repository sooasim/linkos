// F-181 Feature Flag · F-196 실험 프레임워크 · F-188 제품 분석(PII 없는 속성) · F-189 바이럴 계수
// Deterministic hashing so the same subject always lands in the same bucket on every server and client.
import { redactString } from "./redact";

/** FNV-1a 32-bit → [0, buckets). Stable across runtimes (no crypto, no I/O). */
export function hashBucket(seed: string, buckets = 10_000): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // extra avalanche (murmur3 fmix32) so sequential ids spread evenly
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) % buckets;
}

// ---------- F-181 feature flags ----------
export interface FlagDef {
  key: string;
  enabled: boolean;
  /** kill switch: forces OFF for everyone, overriding allowlists */
  killed: boolean;
  rolloutPercent: number;
  allowUsers: string[];
  allowOrgs: string[];
  denyUsers: string[];
}

export interface FlagSubject {
  userId?: string | null;
  anonId?: string | null;
  orgIds?: string[];
}

export type FlagReason = "kill_switch" | "denied" | "disabled" | "user_target" | "org_target" | "rollout" | "outside_rollout";

export function evaluateFlag(flag: FlagDef, subject: FlagSubject): { on: boolean; reason: FlagReason } {
  if (flag.killed) return { on: false, reason: "kill_switch" };
  if (subject.userId && flag.denyUsers.includes(subject.userId)) return { on: false, reason: "denied" };
  if (!flag.enabled) return { on: false, reason: "disabled" };
  if (subject.userId && flag.allowUsers.includes(subject.userId)) return { on: true, reason: "user_target" };
  if (subject.orgIds?.some((o) => flag.allowOrgs.includes(o))) return { on: true, reason: "org_target" };
  const pct = Math.max(0, Math.min(100, flag.rolloutPercent));
  if (pct >= 100) return { on: true, reason: "rollout" };
  const key = subject.userId ?? subject.anonId;
  if (!key || pct <= 0) return { on: false, reason: "outside_rollout" };
  return hashBucket(`flag:${flag.key}:${key}`) < pct * 100 ? { on: true, reason: "rollout" } : { on: false, reason: "outside_rollout" };
}

// ---------- F-196 experiments ----------
export interface ExperimentDef {
  key: string;
  variants: { key: string; weight: number }[];
  /** share of subjects enrolled at all (0–100) */
  trafficPercent: number;
}

/** Deterministic assignment; null = not enrolled (sees the default experience, no exposure). */
export function assignVariant(exp: ExperimentDef, subjectKey: string): string | null {
  const total = exp.variants.reduce((a, v) => a + Math.max(0, v.weight), 0);
  if (!subjectKey || total <= 0) return null;
  if (hashBucket(`exp:${exp.key}:traffic:${subjectKey}`) >= Math.max(0, Math.min(100, exp.trafficPercent)) * 100) return null;
  const point = (hashBucket(`exp:${exp.key}:variant:${subjectKey}`) / 10_000) * total;
  let acc = 0;
  for (const v of exp.variants) {
    acc += Math.max(0, v.weight);
    if (point < acc) return v.key;
  }
  return exp.variants[exp.variants.length - 1]!.key;
}

function erf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export interface VariantResult {
  variant: string;
  exposures: number;
  conversions: number;
  rate: number;
  liftPct: number | null;
  pValue: number | null;
  significant: boolean;
}

/** Two-proportion z-test of each variant against the control (first variant by default). */
export function experimentStats(rows: { variant: string; exposures: number; conversions: number }[], control?: string, alpha = 0.05): VariantResult[] {
  const ctl = rows.find((r) => r.variant === (control ?? rows[0]?.variant));
  return rows.map((r) => {
    const rate = r.exposures ? r.conversions / r.exposures : 0;
    if (!ctl || r === ctl || !ctl.exposures || !r.exposures) return { variant: r.variant, exposures: r.exposures, conversions: r.conversions, rate, liftPct: null, pValue: null, significant: false };
    const p1 = ctl.conversions / ctl.exposures;
    const pooled = (ctl.conversions + r.conversions) / (ctl.exposures + r.exposures);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / ctl.exposures + 1 / r.exposures));
    const z = se ? (rate - p1) / se : 0;
    const pValue = se ? 2 * (1 - normCdf(Math.abs(z))) : 1;
    return {
      variant: r.variant,
      exposures: r.exposures,
      conversions: r.conversions,
      rate,
      liftPct: p1 ? Math.round(((rate - p1) / p1) * 1000) / 10 : null,
      pValue: Math.round(pValue * 10_000) / 10_000,
      significant: pValue < alpha,
    };
  });
}

// ---------- F-188 product analytics (first-party, no PII) ----------
export const PRODUCT_EVENTS = [
  "signup_completed",
  "profile_created",
  "exchange_created",
  "guest_landing_viewed",
  "guest_replied",
  "guest_claimed",
  "card_scanned",
  "contact_created",
  "meeting_created",
  "followup_completed",
  "action_request_submitted",
  "living_update_accepted",
  "checkout_started",
  "subscription_activated",
  "subscription_canceled",
  "usage_limit_hit",
  "experiment_exposed",
  // client-side events
  "page_viewed",
  "cta_clicked",
  "share_opened",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

/** Events a browser may send directly (everything else is emitted server-side only). */
export const CLIENT_EVENTS: readonly ProductEventName[] = ["page_viewed", "cta_clicked", "share_opened"];

export function isProductEvent(x: unknown): x is ProductEventName {
  return typeof x === "string" && (PRODUCT_EVENTS as readonly string[]).includes(x);
}

const PROP_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PII_KEYS = /(email|phone|mobile|name|address|token|note|body|message|password|ip)/;

/**
 * Keep only small primitive properties with safe keys; drop anything that looks like PII
 * (emails/phones/long tokens) instead of storing a masked copy.
 */
export function sanitizeProps(props: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (Object.keys(out).length >= 20) break;
    if (!PROP_KEY.test(k) || PII_KEYS.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      const s = v.slice(0, 64);
      if (redactString(s) !== s) continue;
      out[k] = s;
    }
  }
  return out;
}

// ---------- F-189 viral coefficient ----------
export interface ViralInput {
  /** distinct users who sent at least one exchange in the cohort window */
  senders: number;
  invitesSent: number;
  invitesOpened: number;
  replies: number;
  /** guests who claimed an account after replying (new users acquired) */
  claims: number;
  /** of those claimed users, how many created their own exchange afterwards */
  claimedWhoShared: number;
  /** exchanges created by claimed users */
  sharesByClaimed: number;
}

export function viralMetrics(v: ViralInput) {
  const r = (a: number, b: number, d = 3) => (b ? Math.round((a / b) * 10 ** d) / 10 ** d : null);
  const invitesPerSender = r(v.invitesSent, v.senders);
  const inviteConversion = r(v.claims, v.invitesSent);
  return {
    // K = i × c = (invites / sender) × (new users / invite) = new users / sender
    kFactor: r(v.claims, v.senders),
    invitesPerSender,
    inviteConversion,
    openRate: r(v.invitesOpened, v.invitesSent),
    replyRate: r(v.replies, v.invitesOpened),
    claimRate: r(v.claims, v.replies),
    secondShareRate: r(v.claimedWhoShared, v.claims),
    sharesPerClaimed: r(v.sharesByClaimed, v.claims),
  };
}

// ---------- F-188 / 백서 §23 KPIs: Retention · Match-to-Meeting · Enterprise Active Relationships ----------
/** Relationship actions counted for "월간 관계 행동 재사용" (each maps to an existing table). */
export const RELATIONSHIP_ACTIONS = ["exchange", "encounter", "contact_created", "note", "meeting", "followup_done", "message_sent"] as const;

/** Percentage (one decimal) or null when the denominator is empty. */
export function kpiRate(num: number, den: number): number | null {
  return den > 0 ? Math.round((Math.min(num, den) / den) * 1000) / 10 : null;
}

export interface RetentionInput {
  /** subjects with ≥1 relationship action in the previous window */
  previousActive: number;
  /** of those, subjects with ≥1 relationship action again in the current window */
  retained: number;
  /** subjects active in the current window (incl. new) */
  currentActive: number;
}

/** Retention step: previous-window actives who reused relationship actions in the current window. */
export function retentionStep(r: RetentionInput) {
  return { ...r, retentionRate: kpiRate(r.retained, r.previousActive), churned: Math.max(0, r.previousActive - r.retained) };
}

export function matchToMeeting(matches: number, matchesWithMeeting: number) {
  return { matches, matchesWithMeeting, matchToMeetingRate: kpiRate(matchesWithMeeting, matches) };
}

/** p-quantile (0..1) by linear interpolation; null for no samples. */
export function quantile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}
