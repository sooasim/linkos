// billing module — F-190 개인 플랜, F-191 기업 플랜, F-192 사용량 계량, F-193 결제(Stripe), F-194 구독 관리, F-195 매출지표
// Rules: usage limits apply only to the acting (signed-in) user's own actions — a guest receiving a card is never metered.
// Stripe webhooks are signature-verified and processed at most once per event id (same transaction as the state change).
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DUNNING_GRACE_DAYS,
  METRICS,
  type Metric,
  PLANS,
  PLAN_IDS,
  type PlanId,
  type SubscriptionLike,
  checkLimit,
  dunningState,
  effectivePlan,
  isPlanId,
  limitFor,
  revenueMetrics,
  suggestUpgrade,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { track } from "../lib/metering";
import { type Ctx, appOrigin, audit, log } from "../lib/platform";
import { requireAdmin } from "./growth";
import { notify } from "./inbox";

// ---------- plan resolution ----------
interface SubRow {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  plan: string;
  status: string;
  seats: number;
  amount_cents: number;
  currency: string;
  billing_interval: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  dunning_state: string;
  grace_until: Date | null;
  provider_subscription_id: string | null;
  created_at: Date;
}

const toLike = (s: SubRow): SubscriptionLike & { row: SubRow } => ({
  plan: (isPlanId(s.plan) ? s.plan : "free") as PlanId,
  status: s.status,
  graceUntil: s.grace_until,
  currentPeriodEnd: s.current_period_end,
  seats: s.seats,
  organizationId: s.organization_id,
  row: s,
});

export interface ResolvedPlan {
  plan: PlanId;
  seats: number;
  subject: { type: "user" | "organization"; id: string };
  subscription: SubRow | null;
}

/** Highest entitled plan from the user's own subscription and any organization they are an active member of. */
export async function resolvePlan(userId: string, db: Db = pool()): Promise<ResolvedPlan> {
  const subs = await q<SubRow>(
    `SELECT s.* FROM subscriptions s WHERE s.user_id = $1
     UNION ALL
     SELECT s.* FROM subscriptions s JOIN organization_members m ON m.organization_id = s.organization_id AND m.user_id = $1 AND m.status = 'active'`,
    [userId],
    db,
  );
  const { plan, source } = effectivePlan(subs.map(toLike));
  const row = source?.row ?? null;
  if (row?.organization_id) return { plan, seats: row.seats, subject: { type: "organization", id: row.organization_id }, subscription: row };
  return { plan, seats: 1, subject: { type: "user", id: userId }, subscription: row };
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function paymentRequired(details: Record<string, unknown>) {
  return new ApiError(402, "plan_limit_reached", "이번 달 플랜 사용량을 모두 사용했어요. 플랜을 업그레이드하면 바로 계속할 수 있어요.", details);
}

/**
 * F-192: atomically consume `n` units of `metric` for the acting user (or their organization pool).
 * Throws 402 with upgrade info when the plan limit would be exceeded. Pass the transaction client when called inside tx().
 */
export async function consume(db: Db, userId: string, metric: Metric, n = 1): Promise<{ plan: PlanId; used: number; limit: number | null }> {
  const r = await resolvePlan(userId, db);
  const limit = limitFor(r.plan, metric, r.seats);
  const period = currentPeriod();
  const over = (used: number) => {
    const suggested = suggestUpgrade(r.plan, metric);
    void track(null, "usage_limit_hit", { userId }, { metric, plan: r.plan });
    return paymentRequired({ metric, plan: r.plan, limit, used, suggestedPlan: suggested, upgradeUrl: `${appOrigin()}/app/billing?reason=${metric}` });
  };
  // BILLING_ENFORCEMENT=off keeps counting but never blocks (load tests, staged rollout)
  const enforce = process.env.BILLING_ENFORCEMENT !== "off";
  const cap = enforce ? limit : null;
  if (cap !== null && n > cap) throw over(0);
  const row = await one<{ count: number }>(
    `INSERT INTO usage_counters (subject_type, subject_id, metric, period, count) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (subject_type, subject_id, metric, period) DO UPDATE SET count = usage_counters.count + EXCLUDED.count, updated_at = now()
     WHERE $6::int IS NULL OR usage_counters.count + EXCLUDED.count <= $6::int
     RETURNING count`,
    [r.subject.type, r.subject.id, metric, period, n, cap],
    db,
  );
  if (!row) {
    const cur = await one<{ count: number }>("SELECT count FROM usage_counters WHERE subject_type=$1 AND subject_id=$2 AND metric=$3 AND period=$4", [r.subject.type, r.subject.id, metric, period], db);
    throw over(cur?.count ?? 0);
  }
  return { plan: r.plan, used: row.count, limit };
}

/** Non-throwing quota probe (used by the LLM adapter to degrade to rules instead of blocking). */
export async function tryConsume(userId: string, metric: Metric, n = 1): Promise<boolean> {
  try {
    await consume(pool(), userId, metric, n);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) return false;
    throw e;
  }
}

/** F-191: seat entitlement for organization plans. */
export async function assertSeatAvailable(organizationId: string, db: Db = pool()) {
  const sub = await one<SubRow>(
    "SELECT * FROM subscriptions WHERE organization_id=$1 AND status IN ('active','trialing','past_due') ORDER BY created_at DESC LIMIT 1",
    [organizationId],
    db,
  );
  const used = (await one<{ n: number }>("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND status='active'", [organizationId], db))?.n ?? 0;
  // F-191: team features are an organization plan (business: min 3 seats); an org without one holds only its owner.
  // BILLING_ENFORCEMENT=off counts but never blocks — same switch as the usage meters (test servers, staged rollout).
  const seats = sub && dunningState({ status: sub.status, graceUntil: sub.grace_until }) !== "suspended" ? sub.seats : 1;
  if (process.env.BILLING_ENFORCEMENT === "off") return { used, seats };
  if (used + 1 > seats) throw paymentRequired({ metric: "seats", plan: sub?.plan ?? "free", limit: seats, used, suggestedPlan: sub ? null : "business", upgradeUrl: `${appOrigin()}/app/billing?org=${organizationId}` });
  return { used, seats };
}

async function orgRole(userId: string, organizationId: string, db: Db = pool()) {
  return (await one<{ role: string }>("SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND status='active'", [organizationId, userId], db))?.role ?? null;
}

/** GET /billing — plan, usage meters, subscription state, catalog and organizations the user can buy for. */
export async function billingSummary(userId: string) {
  const r = await resolvePlan(userId);
  const period = currentPeriod();
  const usage = await q<{ metric: string; count: number }>(
    "SELECT metric, count FROM usage_counters WHERE subject_type=$1 AND subject_id=$2 AND period=$3",
    [r.subject.type, r.subject.id, period],
  );
  const used = Object.fromEntries(usage.map((u) => [u.metric, u.count]));
  const orgs = await q<{ id: string; name: string; role: string; members: number }>(
    `SELECT o.id, o.name, m.role, (SELECT count(*)::int FROM organization_members x WHERE x.organization_id=o.id AND x.status='active') AS members
     FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name`,
    [userId],
  );
  const s = r.subscription;
  return {
    plan: r.plan,
    planName: PLANS[r.plan].name,
    scope: r.subject.type,
    seats: r.seats,
    period,
    usage: METRICS.map((m) => ({ metric: m, ...checkLimit(r.plan, m, used[m] ?? 0, 0, r.seats) })),
    subscription: s
      ? {
          id: s.id,
          status: s.status,
          dunning: dunningState({ status: s.status, graceUntil: s.grace_until }),
          graceUntil: s.grace_until,
          cancelAtPeriodEnd: s.cancel_at_period_end,
          currentPeriodEnd: s.current_period_end,
          organizationId: s.organization_id,
        }
      : null,
    organizations: orgs.map((o) => ({ ...o, canManageBilling: ["owner", "admin"].includes(o.role) })),
    catalog: PLAN_IDS.map((id) => ({ id, name: PLANS[id].name, scope: PLANS[id].scope, priceMonthlyCents: PLANS[id].priceMonthlyCents, limits: PLANS[id].limits, seats: PLANS[id].seats, integrations: PLANS[id].integrations, events: PLANS[id].events, features: PLANS[id].features })),
    paymentsConfigured: stripeConfigured(),
  };
}

// ---------- Stripe adapter (F-193) ----------
export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripeBase(): string {
  return (process.env.STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/, "");
}

/** application/x-www-form-urlencoded with Stripe's bracket notation for nested params. */
export function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe<T = any>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw unavailable("payments_not_configured", "결제가 아직 설정되지 않았습니다.");
  const body = params && method === "POST" ? formEncode(params).join("&") : undefined;
  const res = await fetch(`${stripeBase()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": process.env.STRIPE_API_VERSION ?? "2025-09-30.clover",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new ApiError(502, "payment_provider_unreachable", "결제 서비스에 연결하지 못했습니다.", { error: (e as Error).message });
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    log("warn", "stripe.error", { path, status: res.status, type: data?.error?.type });
    throw new ApiError(502, "payment_provider_error", "결제 서비스 오류가 발생했습니다.", { status: res.status, type: data?.error?.type });
  }
  return data as T;
}

function priceEnvKey(plan: PlanId, interval: "month" | "year") {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval === "year" ? "YEARLY" : "MONTHLY"}`;
}

export function priceIdFor(plan: PlanId, interval: "month" | "year"): string | null {
  return process.env[priceEnvKey(plan, interval)] ?? (interval === "month" ? (process.env[`STRIPE_PRICE_${plan.toUpperCase()}`] ?? null) : null);
}

function planForPrice(priceId: string | undefined | null): PlanId | null {
  if (!priceId) return null;
  for (const p of PLAN_IDS) for (const i of ["month", "year"] as const) if (priceIdFor(p, i) === priceId) return p;
  return null;
}

export const checkoutInput = z.object({
  plan: z.enum(["pro", "business"]),
  interval: z.enum(["month", "year"]).default("month"),
  organizationId: z.string().uuid().optional(),
  seats: z.number().int().min(1).max(500).optional(),
});

async function ensureCustomer(subject: { type: "user" | "organization"; id: string }, email: string | null, name: string | null): Promise<string> {
  const col = subject.type === "user" ? "user_id" : "organization_id";
  const existing = await one<{ provider_customer_id: string }>(`SELECT provider_customer_id FROM billing_customers WHERE provider='stripe' AND ${col}=$1`, [subject.id]);
  if (existing) return existing.provider_customer_id;
  const cust = await stripe<{ id: string }>(
    "POST",
    "/v1/customers",
    { email: email ?? undefined, name: name ?? undefined, metadata: { linkos_subject_type: subject.type, linkos_subject_id: subject.id } },
    `linkos-customer-${subject.type}-${subject.id}`,
  );
  await q(`INSERT INTO billing_customers (${col}, provider, provider_customer_id) VALUES ($1,'stripe',$2) ON CONFLICT DO NOTHING`, [subject.id, cust.id]);
  const row = await one<{ provider_customer_id: string }>(`SELECT provider_customer_id FROM billing_customers WHERE provider='stripe' AND ${col}=$1`, [subject.id]);
  // the provider returned a customer already mapped to a different subject — never cross-link billing
  if (!row) throw conflict("billing_customer_conflict", "결제 고객 정보가 다른 계정과 연결되어 있습니다.");
  return row.provider_customer_id;
}

/** POST /billing/checkout — Stripe Checkout (subscription mode). Business plans are bought by an org owner/admin. */
export async function createCheckout(ctx: Ctx, input: z.infer<typeof checkoutInput>, idempotencyKey?: string | null) {
  if (!ctx.userId) throw unauthorized();
  const plan = PLANS[input.plan];
  let subject: { type: "user" | "organization"; id: string };
  let quantity = 1;
  if (plan.scope === "organization") {
    if (!input.organizationId) throw badRequest("organization_required", "기업 플랜은 조직 단위로 구매합니다.");
    const role = await orgRole(ctx.userId, input.organizationId);
    if (!role || !["owner", "admin"].includes(role)) throw forbidden("조직 관리자만 결제할 수 있습니다.");
    const members = (await one<{ n: number }>("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND status='active'", [input.organizationId]))?.n ?? 1;
    quantity = Math.max(input.seats ?? 0, plan.seats?.min ?? 1, members);
    subject = { type: "organization", id: input.organizationId };
  } else {
    if (input.organizationId) throw badRequest("personal_plan", "개인 플랜은 조직에 적용할 수 없습니다.");
    subject = { type: "user", id: ctx.userId };
  }
  const price = priceIdFor(input.plan, input.interval);
  if (!price) throw unavailable("price_not_configured", "해당 플랜 가격이 아직 설정되지 않았습니다.");
  const u = await one<{ email: string | null; display_name: string | null }>("SELECT email, display_name FROM users WHERE id=$1", [ctx.userId]);
  const orgName = subject.type === "organization" ? ((await one<{ name: string }>("SELECT name FROM organizations WHERE id=$1", [subject.id]))?.name ?? null) : null;
  const customer = await ensureCustomer(subject, u?.email ?? null, orgName ?? u?.display_name ?? null);
  const meta = { plan: input.plan, subject_type: subject.type, subject_id: subject.id, linkos_user_id: ctx.userId };
  const origin = appOrigin();
  const session = await stripe<{ id: string; url: string }>(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer,
      client_reference_id: subject.id,
      line_items: [{ price, quantity }],
      allow_promotion_codes: true,
      success_url: `${origin}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/billing?checkout=cancel`,
      metadata: meta,
      subscription_data: { metadata: meta },
    },
    idempotencyKey ? `linkos-checkout-${ctx.userId}-${idempotencyKey}` : undefined,
  );
  await audit(pool(), ctx, "billing.checkout_started", subject.type, subject.id, { plan: input.plan, interval: input.interval, quantity }, subject.type === "organization" ? subject.id : null);
  void track(null, "checkout_started", { userId: ctx.userId }, { plan: input.plan, interval: input.interval, seats: quantity });
  return { id: session.id, url: session.url };
}

/** POST /billing/portal — Stripe Customer Portal (upgrade/downgrade/cancel/payment method). */
export async function createPortal(ctx: Ctx, organizationId?: string) {
  if (!ctx.userId) throw unauthorized();
  if (organizationId) {
    const role = await orgRole(ctx.userId, organizationId);
    if (!role || !["owner", "admin"].includes(role)) throw forbidden("조직 관리자만 결제를 관리할 수 있습니다.");
  }
  const col = organizationId ? "organization_id" : "user_id";
  const c = await one<{ provider_customer_id: string }>(`SELECT provider_customer_id FROM billing_customers WHERE provider='stripe' AND ${col}=$1`, [organizationId ?? ctx.userId]);
  if (!c) throw notFound("billing customer");
  const s = await stripe<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: c.provider_customer_id, return_url: `${appOrigin()}/app/billing` });
  await audit(pool(), ctx, "billing.portal_opened", organizationId ? "organization" : "user", organizationId ?? ctx.userId);
  return { url: s.url };
}

// ---------- webhook (F-193/F-194) ----------
/** Verify a `Stripe-Signature` header (t=…,v1=…) over the raw body. Constant-time compare, replay tolerance. */
export function verifyStripeSignature(payload: string, header: string | null | undefined, secret: string, toleranceSec = 300, nowMs = Date.now()): boolean {
  if (!header) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "t" && v) t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === null || !Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex"), "utf8");
  return sigs.some((s) => {
    const got = Buffer.from(s, "utf8");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

type StripeEvent = { id: string; type: string; created: number; data: { object: any } };

const subId = (x: unknown): string | null => (typeof x === "string" ? x : (x as { id?: string } | null)?.id ?? null);

async function subjectFor(c: Db, obj: { metadata?: Record<string, string>; customer?: unknown }): Promise<{ type: "user" | "organization"; id: string } | null> {
  const m = obj.metadata ?? {};
  if ((m.subject_type === "user" || m.subject_type === "organization") && /^[0-9a-f-]{36}$/i.test(m.subject_id ?? "")) return { type: m.subject_type, id: m.subject_id! };
  const cust = subId(obj.customer);
  if (!cust) return null;
  const r = await one<{ user_id: string | null; organization_id: string | null }>("SELECT user_id, organization_id FROM billing_customers WHERE provider='stripe' AND provider_customer_id=$1", [cust], c);
  if (!r) return null;
  return r.user_id ? { type: "user", id: r.user_id } : { type: "organization", id: r.organization_id! };
}

async function upsertSubscription(c: Db, s: any, eventAt: Date): Promise<string> {
  const subject = await subjectFor(c, s);
  if (!subject) return "unknown_subject";
  const item = s.items?.data?.[0] ?? {};
  const price = item.price ?? s.plan ?? {};
  const plan: PlanId | null = (isPlanId(s.metadata?.plan) ? (s.metadata.plan as PlanId) : null) ?? planForPrice(price.id);
  if (!plan) return "unknown_plan";
  const status: string = s.status;
  const periodStart = item.current_period_start ?? s.current_period_start ?? null;
  const periodEnd = item.current_period_end ?? s.current_period_end ?? null;
  const dunning = status === "active" || status === "trialing" ? "ok" : status === "past_due" ? "grace" : "suspended";
  const prev = await one<{ status: string }>("SELECT status FROM subscriptions WHERE provider_subscription_id=$1", [s.id], c);
  const r = await one<{ id: string }>(
    `INSERT INTO subscriptions (user_id, organization_id, plan, status, provider, provider_customer_id, provider_subscription_id, amount_cents, currency, billing_interval, seats,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at, dunning_state, grace_until, last_event_at)
     VALUES ($1,$2,$3,$4,'stripe',$5,$6,$7,$8,$9,$10, to_timestamp($11), to_timestamp($12), $13, to_timestamp($14), $15,
       CASE WHEN $15 = 'grace' THEN now() + make_interval(days => $17) END, $16)
     ON CONFLICT (provider_subscription_id) DO UPDATE SET
       plan=EXCLUDED.plan, status=EXCLUDED.status, amount_cents=EXCLUDED.amount_cents, currency=EXCLUDED.currency, billing_interval=EXCLUDED.billing_interval,
       seats=EXCLUDED.seats, current_period_start=EXCLUDED.current_period_start, current_period_end=EXCLUDED.current_period_end,
       cancel_at_period_end=EXCLUDED.cancel_at_period_end, canceled_at=EXCLUDED.canceled_at, dunning_state=EXCLUDED.dunning_state,
       grace_until = CASE WHEN EXCLUDED.dunning_state = 'grace' THEN COALESCE(subscriptions.grace_until, EXCLUDED.grace_until) ELSE NULL END,
       failed_payment_count = CASE WHEN EXCLUDED.dunning_state = 'ok' THEN 0 ELSE subscriptions.failed_payment_count END,
       last_event_at=EXCLUDED.last_event_at, updated_at=now()
     WHERE subscriptions.last_event_at IS NULL OR subscriptions.last_event_at <= EXCLUDED.last_event_at
     RETURNING id`,
    [
      subject.type === "user" ? subject.id : null,
      subject.type === "organization" ? subject.id : null,
      plan,
      status,
      subId(s.customer),
      s.id,
      price.unit_amount ?? 0,
      price.currency ?? "usd",
      price.recurring?.interval === "year" ? "year" : "month",
      item.quantity ?? s.quantity ?? 1,
      periodStart,
      periodEnd,
      Boolean(s.cancel_at_period_end),
      s.canceled_at ?? s.ended_at ?? null,
      dunning,
      eventAt,
      DUNNING_GRACE_DAYS,
    ],
    c,
  );
  if (!r) return "stale_event_ignored";
  const actor = subject.type === "user" ? subject.id : null;
  if (actor && prev?.status !== status) {
    if ((status === "active" || status === "trialing") && prev?.status !== "active") {
      await track(c, "subscription_activated", { userId: actor }, { plan, status });
      await notify(c, actor, { kind: "billing", title: `${PLANS[plan].name} 플랜이 활성화됐어요`, link: "/app/billing", dedupeKey: `billing:${s.id}:${status}` });
    } else if (status === "canceled") {
      await track(c, "subscription_canceled", { userId: actor }, { plan });
    }
  }
  await audit(c, { userId: null }, "billing.subscription_synced", "subscription", r.id, { status, plan }, subject.type === "organization" ? subject.id : null);
  return "synced";
}

async function billingAdmins(c: Db, subscriptionRowId: string): Promise<string[]> {
  const rows = await q<{ uid: string }>(
    `SELECT s.user_id AS uid FROM subscriptions s WHERE s.id=$1 AND s.user_id IS NOT NULL
     UNION SELECT m.user_id FROM subscriptions s JOIN organization_members m ON m.organization_id=s.organization_id AND m.role IN ('owner','admin') AND m.status='active' WHERE s.id=$1`,
    [subscriptionRowId],
    c,
  );
  return rows.map((r) => r.uid);
}

async function onInvoice(c: Db, invoice: any, failed: boolean): Promise<string> {
  const sid = subId(invoice.subscription) ?? subId(invoice.parent?.subscription_details?.subscription);
  if (!sid) return "no_subscription";
  if (failed) {
    const r = await one<{ id: string; failed_payment_count: number; grace_until: Date }>(
      `UPDATE subscriptions SET failed_payment_count = failed_payment_count + 1,
         dunning_state = CASE WHEN status IN ('canceled','unpaid','incomplete_expired') THEN 'suspended' ELSE 'grace' END,
         status = CASE WHEN status IN ('active','trialing') THEN 'past_due' ELSE status END,
         grace_until = COALESCE(grace_until, now() + make_interval(days => $2)), updated_at = now()
       WHERE provider_subscription_id=$1 RETURNING id, failed_payment_count, grace_until`,
      [sid, DUNNING_GRACE_DAYS],
      c,
    );
    if (!r) return "unknown_subscription";
    for (const uid of await billingAdmins(c, r.id)) {
      await notify(c, uid, {
        kind: "billing",
        title: "결제에 실패했어요",
        body: `결제 수단을 확인해 주세요. ${new Date(r.grace_until).toLocaleDateString("ko-KR")}까지는 현재 플랜이 유지됩니다.`,
        link: "/app/billing",
        dedupeKey: `dunning:${sid}:${r.failed_payment_count}`,
      });
    }
    return "dunning";
  }
  await c.query(
    `UPDATE subscriptions SET failed_payment_count=0, dunning_state='ok', grace_until=NULL,
       status = CASE WHEN status='past_due' THEN 'active' ELSE status END, updated_at=now() WHERE provider_subscription_id=$1`,
    [sid],
  );
  return "paid";
}

/** POST /billing/webhooks/stripe — raw body + Stripe-Signature. Idempotent per event id. */
export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<{ received: true; duplicate: boolean; outcome: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw unavailable("webhook_not_configured", "webhook secret is not configured");
  if (!verifyStripeSignature(rawBody, signature, secret, Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC ?? 300))) throw badRequest("invalid_signature", "invalid webhook signature");
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw badRequest("invalid_json");
  }
  if (!event?.id || !event.type) throw badRequest("invalid_event");
  const eventAt = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000);

  // checkout completion only carries the subscription id — fetch it before opening the transaction (no network inside tx)
  let fetched: any = null;
  if (event.type === "checkout.session.completed" && event.data.object?.mode === "subscription") {
    const sid = subId(event.data.object.subscription);
    if (sid) fetched = await stripe("GET", `/v1/subscriptions/${encodeURIComponent(sid)}`);
  }

  return tx(async (c) => {
    const fresh = await one<{ event_id: string }>(
      "INSERT INTO billing_webhook_events (provider, event_id, event_type) VALUES ('stripe',$1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.id, event.type],
      c,
    );
    if (!fresh) return { received: true as const, duplicate: true, outcome: "duplicate" };
    let outcome = "ignored";
    const obj = event.data.object ?? {};
    switch (event.type) {
      case "checkout.session.completed": {
        const subject = await subjectFor(c, obj);
        const cust = subId(obj.customer);
        if (subject && cust) {
          const col = subject.type === "user" ? "user_id" : "organization_id";
          await c.query(`INSERT INTO billing_customers (${col}, provider, provider_customer_id) VALUES ($1,'stripe',$2) ON CONFLICT DO NOTHING`, [subject.id, cust]);
        }
        outcome = fetched ? await upsertSubscription(c, { ...fetched, metadata: { ...(obj.metadata ?? {}), ...(fetched.metadata ?? {}) } }, eventAt) : "no_subscription";
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        outcome = await upsertSubscription(c, obj, eventAt);
        break;
      case "invoice.payment_failed":
        outcome = await onInvoice(c, obj, true);
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded":
        outcome = await onInvoice(c, obj, false);
        break;
      default:
        break;
    }
    await c.query("UPDATE billing_webhook_events SET processed_at=now(), outcome=$3 WHERE provider=$1 AND event_id=$2", ["stripe", event.id, outcome]);
    return { received: true as const, duplicate: false, outcome };
  });
}

// ---------- F-195 admin revenue ----------
export async function revenueReport(ctx: Ctx) {
  await requireAdmin(ctx);
  const subs = await q<SubRow & { customer_key: string }>(
    "SELECT s.*, COALESCE(s.provider_customer_id, COALESCE(s.user_id, s.organization_id)::text) AS customer_key FROM subscriptions s",
  );
  const metrics = revenueMetrics(
    subs.map((s) => ({ status: s.status, amountCents: s.amount_cents, interval: s.billing_interval === "year" ? "year" : "month", quantity: s.seats, createdAt: s.created_at, canceledAt: s.canceled_at, customerKey: s.customer_key })),
  );
  const byPlan = await q<{ plan: string; status: string; n: number }>("SELECT plan, status, count(*)::int AS n FROM subscriptions GROUP BY 1,2 ORDER BY 1,2");
  const dunning = await q<{ dunning_state: string; n: number }>("SELECT dunning_state, count(*)::int AS n FROM subscriptions WHERE status NOT IN ('canceled','incomplete_expired') GROUP BY 1");
  await audit(pool(), ctx, "admin.revenue_viewed", null, null);
  return { ...metrics, currency: "usd", byPlan, dunning };
}
