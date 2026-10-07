// F-190 개인 플랜 · F-191 기업 플랜 · F-192 사용량 계량 · F-194 구독 상태(dunning) · F-195 매출지표 · F-187 비용계측
// Pure plan catalog + entitlement / revenue / cost math. No I/O.

export const PLAN_IDS = ["free", "pro", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Metered usage dimensions (monthly period). */
export const METRICS = ["exchanges", "ocr_scans", "ai_calls", "exports", "stt_minutes"] as const;
export type Metric = (typeof METRICS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  scope: "personal" | "organization";
  /** USD cents per month (per seat for organization plans); null = contract pricing */
  priceMonthlyCents: number | null;
  /** monthly limits; organization plans are per seat and pooled; null = unlimited */
  limits: Record<Metric, number | null>;
  integrations: number | null;
  events: number | null;
  seats: { min: number; max: number | null } | null;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    scope: "personal",
    priceMonthlyCents: 0,
    limits: { exchanges: 50, ocr_scans: 30, ai_calls: 20, exports: 3, stt_minutes: 0 },
    integrations: 1,
    events: 1,
    seats: null,
    features: ["living_card", "guest_exchange", "basic_crm"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    scope: "personal",
    priceMonthlyCents: 1200,
    limits: { exchanges: 2000, ocr_scans: 500, ai_calls: 500, exports: 100, stt_minutes: 300 },
    integrations: 5,
    events: 20,
    seats: null,
    features: ["living_card", "guest_exchange", "basic_crm", "audience_variants", "ai_assist", "meeting_memory", "action_card"],
  },
  business: {
    id: "business",
    name: "Business",
    scope: "organization",
    priceMonthlyCents: 2900,
    limits: { exchanges: null, ocr_scans: 1000, ai_calls: 1000, exports: null, stt_minutes: 600 },
    integrations: null,
    events: null,
    seats: { min: 3, max: 500 },
    features: ["living_card", "guest_exchange", "basic_crm", "audience_variants", "ai_assist", "meeting_memory", "action_card", "booth_lead_flow", "organizer_api", "team_workspace"],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    scope: "organization",
    priceMonthlyCents: null,
    limits: { exchanges: null, ocr_scans: null, ai_calls: null, exports: null, stt_minutes: null },
    integrations: null,
    events: null,
    seats: { min: 10, max: null },
    features: ["living_card", "guest_exchange", "basic_crm", "audience_variants", "ai_assist", "meeting_memory", "action_card", "booth_lead_flow", "organizer_api", "team_workspace", "sso", "audit_export", "dedicated_region"],
  },
};

const RANK: Record<PlanId, number> = { free: 0, pro: 1, business: 2, enterprise: 3 };

export function isPlanId(x: unknown): x is PlanId {
  return typeof x === "string" && (PLAN_IDS as readonly string[]).includes(x);
}

/** Monthly limit for a plan; organization plans scale per seat (pooled). null = unlimited. */
export function limitFor(planId: PlanId, metric: Metric, seats = 1): number | null {
  const plan = PLANS[planId];
  const base = plan.limits[metric];
  if (base === null) return null;
  return plan.scope === "organization" ? base * Math.max(seats, plan.seats?.min ?? 1) : base;
}

export interface LimitCheck {
  allowed: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

export function checkLimit(planId: PlanId, metric: Metric, used: number, increment = 1, seats = 1): LimitCheck {
  const limit = limitFor(planId, metric, seats);
  if (limit === null) return { allowed: true, limit: null, used, remaining: null };
  return { allowed: used + increment <= limit, limit, used, remaining: Math.max(0, limit - used) };
}

/** Cheapest plan above `current` that raises the limit for `metric` (personal users are offered Pro first). */
export function suggestUpgrade(current: PlanId, metric: Metric): PlanId | null {
  const curLimit = PLANS[current].limits[metric];
  for (const id of PLAN_IDS) {
    if (RANK[id] <= RANK[current]) continue;
    const l = PLANS[id].limits[metric];
    if (l === null || curLimit === null || l > curLimit) return id;
  }
  return null;
}

export function hasFeature(planId: PlanId, feature: string): boolean {
  return PLANS[planId].features.includes(feature);
}

// ---------- subscription state → entitlement (F-194 dunning/grace) ----------
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type DunningState = "ok" | "grace" | "suspended";

export const DUNNING_GRACE_DAYS = 7;

export interface SubscriptionLike {
  plan: PlanId;
  status: SubscriptionStatus | string;
  graceUntil?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
  seats?: number | null;
  organizationId?: string | null;
}

const ts = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

export function dunningState(sub: Pick<SubscriptionLike, "status" | "graceUntil">, now: Date = new Date()): DunningState {
  if (sub.status === "active" || sub.status === "trialing") return "ok";
  if (sub.status === "past_due") {
    const g = ts(sub.graceUntil);
    return g !== null && g > now.getTime() ? "grace" : "suspended";
  }
  return "suspended";
}

export function isEntitled(sub: SubscriptionLike, now: Date = new Date()): boolean {
  const d = dunningState(sub, now);
  if (d === "ok" || d === "grace") return true;
  // canceled immediately but paid through the end of the period
  if (sub.status === "canceled") {
    const end = ts(sub.currentPeriodEnd);
    return end !== null && end > now.getTime();
  }
  return false;
}

/** Highest entitled plan across personal + organization subscriptions; falls back to Free. */
export function effectivePlan<S extends SubscriptionLike>(subs: S[], now: Date = new Date()): { plan: PlanId; source: S | null } {
  let best: S | null = null;
  for (const s of subs) {
    if (!isPlanId(s.plan) || !isEntitled(s, now)) continue;
    if (!best || RANK[s.plan] > RANK[best.plan]) best = s;
  }
  return { plan: best?.plan ?? "free", source: best };
}

// ---------- F-195 revenue metrics ----------
export interface RevenueSub {
  status: string;
  amountCents: number;
  interval: "month" | "year";
  quantity: number;
  createdAt: Date | string;
  canceledAt?: Date | string | null;
  customerKey: string;
}

export function monthlyAmount(s: Pick<RevenueSub, "amountCents" | "interval" | "quantity">): number {
  const per = s.interval === "year" ? s.amountCents / 12 : s.amountCents;
  return per * Math.max(1, s.quantity);
}

const PAYING = new Set(["active", "past_due"]);

export function revenueMetrics(subs: RevenueSub[], now: Date = new Date(), windowDays = 30) {
  const start = now.getTime() - windowDays * 864e5;
  const live = subs.filter((s) => PAYING.has(s.status) && s.amountCents > 0);
  const mrrCents = Math.round(live.reduce((a, s) => a + monthlyAmount(s), 0));
  const customers = new Set(live.map((s) => s.customerKey)).size;
  // logo churn: paid subscriptions alive at window start that were canceled inside the window
  const aliveAtStart = subs.filter((s) => s.amountCents > 0 && ts(s.createdAt)! <= start && (ts(s.canceledAt) === null || ts(s.canceledAt)! > start));
  const churned = aliveAtStart.filter((s) => {
    const c = ts(s.canceledAt);
    return c !== null && c <= now.getTime();
  });
  const churnedMrr = churned.reduce((a, s) => a + monthlyAmount(s), 0);
  const startMrr = aliveAtStart.reduce((a, s) => a + monthlyAmount(s), 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    mrrCents,
    arrCents: mrrCents * 12,
    payingCustomers: customers,
    arpuCents: customers ? Math.round(mrrCents / customers) : 0,
    logoChurnRate: pct(churned.length, aliveAtStart.length),
    revenueChurnRate: pct(churnedMrr, startMrr),
    windowDays,
  };
}

// ---------- F-187 cost metering (estimates; override with COST_RATES_JSON) ----------
/** micro-USD per unit. These are configurable estimates, not invoices. */
export const DEFAULT_COST_RATES: Record<string, number> = {
  "llm.input_token": 5, // ≈ $5 / 1M input tokens
  "llm.output_token": 25, // ≈ $25 / 1M output tokens
  "ocr.page.on_device": 0, // tesseract.js runs on the user's device
  "ocr.page.server": 1500, // ≈ $1.50 / 1k pages for a hosted OCR adapter
  "stt.minute": 6000, // ≈ $0.006 / minute
  "email.message": 100, // ≈ $0.10 / 1k messages
  "storage.gb_month": 23000,
};

export function estimateCostMicros(rateKey: string, units: number, overrides: Record<string, number> = {}): number {
  const rate = overrides[rateKey] ?? DEFAULT_COST_RATES[rateKey] ?? 0;
  return Math.max(0, Math.round(rate * units));
}
