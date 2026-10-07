// Track D integration — F-031 F-032 F-033 F-036 F-147 F-149 F-151 F-180 F-181 F-187 F-188 F-189 F-190 F-191 F-192 F-193 F-194 F-195 F-196
// Real PostgreSQL (DATABASE_URL), a local fake Stripe API (STRIPE_API_BASE) and a fake OTLP collector.
import { createHmac } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_d";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { relayOutbox } = await import("../src/worker");
const { billing, booth, capture, card, event, growth, handoff, identity, inbox, living, tracing, q, one, closePool } = api;

const ctx = (userId: string | null, ip = "10.4.0.1") => ({ userId, ip, userAgent: "test", requestId: "t" });
const consents = ["terms", "privacy", "age_14"].map((type) => ({ type: type as "terms", granted: true }));
const base = { company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [], theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [] };
const stamp = Date.now();
let n = 0;
async function user(prefix = "d") {
  const email = `${prefix}${stamp}-${n++}@trackd.test`;
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}
const guestCard = (name = "게스트") => ({ card: { fullName: name, company: "게스트사", email: "g@guest.test" }, sharedFields: ["fullName", "company", "email"] as ("fullName" | "company" | "email")[], consent: { exchange: true as const }, provenance: {} });
const period = billing.currentPeriod();
async function setUsage(userId: string, metric: string, count: number) {
  await q(
    `INSERT INTO usage_counters (subject_type, subject_id, metric, period, count) VALUES ('user',$1,$2,$3,$4)
     ON CONFLICT (subject_type, subject_id, metric, period) DO UPDATE SET count=EXCLUDED.count`,
    [userId, metric, period, count],
  );
}

// ---------- fake Stripe ----------
const stripeSeen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const stripeSubs = new Map<string, any>();
let custSeq = 0;
const fakeStripe = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  stripeSeen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
  const send = (code: number, o: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (req.headers.authorization !== "Bearer sk_test_trackd") return send(401, { error: { type: "invalid_request_error" } });
  if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_${stamp}_${++custSeq}` });
  if (req.method === "POST" && req.url === "/v1/checkout/sessions") return send(200, { id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" });
  if (req.method === "POST" && req.url === "/v1/billing_portal/sessions") return send(200, { url: "https://billing.stripe.test/p/1" });
  const m = /^\/v1\/subscriptions\/(.+)$/.exec(req.url ?? "");
  if (req.method === "GET" && m && stripeSubs.has(m[1]!)) return send(200, stripeSubs.get(m[1]!));
  send(404, { error: { type: "invalid_request_error" } });
});

// ---------- fake OTLP collector ----------
const otlp: any[] = [];
const collector = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  otlp.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});

const WH_SECRET = "whsec_trackd_test";
function signed(event: unknown, secret = WH_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  return { body, sig: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` };
}
const now = () => Math.floor(Date.now() / 1000);
function stripeSub(id: string, customer: string, status: string, meta: Record<string, string>, price = { id: "price_pro_m", unit_amount: 1200 }, quantity = 1) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    metadata: meta,
    cancel_at_period_end: false,
    canceled_at: status === "canceled" ? now() : null,
    items: { data: [{ price: { ...price, currency: "usd", recurring: { interval: "month" } }, quantity, current_period_start: now(), current_period_end: now() + 30 * 86400 }] },
  };
}

beforeAll(async () => {
  await migrate();
  await new Promise<void>((r) => fakeStripe.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  process.env.STRIPE_SECRET_KEY = "sk_test_trackd";
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${(fakeStripe.address() as { port: number }).port}`;
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_biz_m";
});
afterAll(async () => {
  fakeStripe.close();
  collector.close();
  await closePool();
});

describe("F-190/F-192 plans & usage metering", () => {
  it("Free plan meters exchanges; over the limit → 402 with upgrade info; guests can still receive & reply", async () => {
    const u = await user();
    await card.saveProfile(ctx(u.id), { ...base, name: "미터링" });
    const s = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: {} });
    expect((await billing.billingSummary(u.id)).usage.find((x) => x.metric === "exchanges")).toMatchObject({ used: 1, limit: 50, remaining: 49 });
    await setUsage(u.id, "exchanges", 50);
    const err = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "plan_limit_reached" });
    expect(err.details).toMatchObject({ metric: "exchanges", plan: "free", limit: 50, suggestedPlan: "pro" });
    expect(err.details.upgradeUrl).toContain("/app/billing");
    // counter not incremented by the rejected attempt
    expect((await one<{ count: number }>("SELECT count FROM usage_counters WHERE subject_id=$1 AND metric='exchanges'", [u.id]))!.count).toBe(50);
    // the guest side is never blocked by the sender's quota
    await handoff.openGuestLanding(s.token, ctx(null), "anon-1");
    const r = await handoff.replyExchange(s.token, ctx(null), guestCard());
    expect(r.exchanged).toBe(true);
    expect(await one("SELECT 1 FROM product_events WHERE name='usage_limit_hit' AND user_id=$1", [u.id])).toBeTruthy();
    // staged rollout switch: count but don't block
    process.env.BILLING_ENFORCEMENT = "off";
    await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: {} });
    delete process.env.BILLING_ENFORCEMENT;
  });

  it("OCR scans are metered and cost-recorded (F-187)", async () => {
    const u = await user();
    const job = await capture.captureBusinessCard(ctx(u.id), { side: "front", kind: "card", engine: "tesseract.js", lines: [{ text: "홍길동", confidence: 90 }] });
    expect(await one("SELECT 1 FROM cost_ledger WHERE user_id=$1 AND job_type='ocr' AND job_id=$2 AND cost_micros=0", [u.id, job.id])).toBeTruthy();
    await capture.captureBusinessCard(ctx(u.id), { side: "front", kind: "card", engine: "cloud-vision", lines: [{ text: "김철수", confidence: 90 }] });
    expect((await one<{ cost_micros: string }>("SELECT cost_micros FROM cost_ledger WHERE user_id=$1 AND provider='cloud-vision'", [u.id]))!.cost_micros).toBe("1500");
    await setUsage(u.id, "ocr_scans", 30);
    await expect(capture.captureBusinessCard(ctx(u.id), { side: "front", kind: "card", engine: "tesseract.js", lines: [{ text: "x" }] })).rejects.toMatchObject({ status: 402 });
  });
});

describe("F-193/F-194 Stripe checkout, portal, webhooks", () => {
  it("creates a customer + checkout session with form-encoded params and idempotency", async () => {
    const u = await user();
    const r = await billing.createCheckout(ctx(u.id), { plan: "pro", interval: "month" }, "idem-1");
    expect(r.url).toContain("checkout.stripe.test");
    const cs = stripeSeen.find((x) => x.url === "/v1/checkout/sessions")!;
    const p = new URLSearchParams(cs.body);
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("line_items[0][price]")).toBe("price_pro_m");
    expect(p.get("subscription_data[metadata][plan]")).toBe("pro");
    expect(p.get("subscription_data[metadata][subject_id]")).toBe(u.id);
    expect(cs.headers["idempotency-key"]).toContain("idem-1");
    expect(await one("SELECT 1 FROM billing_customers WHERE user_id=$1", [u.id])).toBeTruthy();
    // business plan requires an organization
    await expect(billing.createCheckout(ctx(u.id), { plan: "business", interval: "month" })).rejects.toMatchObject({ code: "organization_required" });
    expect((await billing.createPortal(ctx(u.id))).url).toContain("billing.stripe.test");
  });

  it("verifies signatures, syncs subscription state, is idempotent, handles dunning + stale events", async () => {
    const u = await user();
    await billing.createCheckout(ctx(u.id), { plan: "pro", interval: "month" });
    const cust = (await one<{ provider_customer_id: string }>("SELECT provider_customer_id FROM billing_customers WHERE user_id=$1", [u.id]))!.provider_customer_id;
    const subId = `sub_${stamp}`;
    stripeSubs.set(subId, stripeSub(subId, cust, "active", { plan: "pro", subject_type: "user", subject_id: u.id }));

    const evt = { id: `evt_cs_${stamp}`, type: "checkout.session.completed", created: now(), data: { object: { mode: "subscription", customer: cust, subscription: subId, client_reference_id: u.id, metadata: { plan: "pro", subject_type: "user", subject_id: u.id } } } };
    const good = signed(evt);
    // bad signature / wrong secret / replayed timestamp
    await expect(billing.handleStripeWebhook(good.body, good.sig.replace(/v1=./, "v1=0"))).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(billing.handleStripeWebhook(good.body, signed(evt, "whsec_other").sig)).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(billing.handleStripeWebhook(good.body, signed(evt, WH_SECRET, now() - 3600).sig)).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(billing.handleStripeWebhook(good.body + " ", good.sig)).rejects.toMatchObject({ code: "invalid_signature" });

    expect(await billing.handleStripeWebhook(good.body, good.sig)).toMatchObject({ duplicate: false, outcome: "synced" });
    expect(await billing.handleStripeWebhook(good.body, good.sig)).toMatchObject({ duplicate: true });
    expect((await billing.resolvePlan(u.id)).plan).toBe("pro");
    expect((await billing.billingSummary(u.id)).usage.find((x) => x.metric === "exchanges")!.limit).toBe(2000);
    expect(await one("SELECT 1 FROM product_events WHERE name='subscription_activated' AND user_id=$1", [u.id])).toBeTruthy();
    expect((await inbox.listNotifications(u.id)).some((x) => x.kind === "billing")).toBe(true);

    // payment failure → past_due + grace, plan kept, admins notified
    const fail = signed({ id: `evt_fail_${stamp}`, type: "invoice.payment_failed", created: now(), data: { object: { id: "in_1", subscription: subId } } });
    expect(await billing.handleStripeWebhook(fail.body, fail.sig)).toMatchObject({ outcome: "dunning" });
    const sub = (await one<any>("SELECT * FROM subscriptions WHERE provider_subscription_id=$1", [subId]))!;
    expect(sub).toMatchObject({ status: "past_due", dunning_state: "grace", failed_payment_count: 1 });
    expect(new Date(sub.grace_until).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);
    expect((await billing.resolvePlan(u.id)).plan).toBe("pro");
    expect((await billing.billingSummary(u.id)).subscription).toMatchObject({ dunning: "grace" });
    // grace expired → Free entitlements
    await q("UPDATE subscriptions SET grace_until = now() - interval '1 minute' WHERE provider_subscription_id=$1", [subId]);
    expect((await billing.resolvePlan(u.id)).plan).toBe("free");
    // paid → back to ok
    const paid = signed({ id: `evt_paid_${stamp}`, type: "invoice.paid", created: now(), data: { object: { id: "in_2", subscription: subId } } });
    await billing.handleStripeWebhook(paid.body, paid.sig);
    expect(await one("SELECT 1 FROM subscriptions WHERE provider_subscription_id=$1 AND status='active' AND dunning_state='ok' AND grace_until IS NULL", [subId])).toBeTruthy();

    // cancellation, then an older (out-of-order) update is ignored
    const del = signed({ id: `evt_del_${stamp}`, type: "customer.subscription.deleted", created: now() + 5, data: { object: stripeSub(subId, cust, "canceled", { plan: "pro", subject_type: "user", subject_id: u.id }) } });
    await billing.handleStripeWebhook(del.body, del.sig);
    const stale = signed({ id: `evt_stale_${stamp}`, type: "customer.subscription.updated", created: now() - 100, data: { object: stripeSub(subId, cust, "active", { plan: "pro", subject_type: "user", subject_id: u.id }) } });
    expect(await billing.handleStripeWebhook(stale.body, stale.sig)).toMatchObject({ outcome: "stale_event_ignored" });
    expect((await one<{ status: string }>("SELECT status FROM subscriptions WHERE provider_subscription_id=$1", [subId]))!.status).toBe("canceled");
  });

  it("F-191 organization plan: admin-only checkout, per-seat pooled limits, seat enforcement", async () => {
    const owner = await user("own");
    const member = await user("mem");
    const org = (await one<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ('ACME', $1) RETURNING id", [`acme-${stamp}`]))!.id;
    await q("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')", [org, owner.id, member.id]);
    await expect(billing.createCheckout(ctx(member.id), { plan: "business", interval: "month", organizationId: org })).rejects.toMatchObject({ status: 403 });
    await billing.createCheckout(ctx(owner.id), { plan: "business", interval: "month", organizationId: org, seats: 2 });
    const cs = stripeSeen.filter((x) => x.url === "/v1/checkout/sessions").at(-1)!;
    expect(new URLSearchParams(cs.body).get("line_items[0][quantity]")).toBe("3"); // seat minimum
    await expect(billing.assertSeatAvailable(org)).rejects.toMatchObject({ status: 402 }); // free org: 1 seat
    const cust = (await one<{ provider_customer_id: string }>("SELECT provider_customer_id FROM billing_customers WHERE organization_id=$1", [org]))!.provider_customer_id;
    const e = signed({ id: `evt_org_${stamp}`, type: "customer.subscription.created", created: now(), data: { object: stripeSub(`sub_org_${stamp}`, cust, "active", { plan: "business", subject_type: "organization", subject_id: org }, { id: "price_biz_m", unit_amount: 2900 }, 3) } });
    await billing.handleStripeWebhook(e.body, e.sig);
    const r = await billing.resolvePlan(member.id);
    expect(r).toMatchObject({ plan: "business", seats: 3, subject: { type: "organization", id: org } });
    expect((await billing.billingSummary(member.id)).usage.find((x) => x.metric === "ocr_scans")!.limit).toBe(3000);
    expect(await billing.assertSeatAvailable(org)).toMatchObject({ used: 2, seats: 3 });
  });

  it("F-195 admin revenue metrics are admin-only", async () => {
    const plain = await user();
    await expect(billing.revenueReport(ctx(plain.id))).rejects.toMatchObject({ status: 403 });
    const admin = await user("adm");
    await q("UPDATE users SET is_platform_admin=true WHERE id=$1", [admin.id]);
    const r = await billing.revenueReport(ctx(admin.id));
    expect(r.mrrCents).toBeGreaterThanOrEqual(2900 * 3);
    expect(r.arrCents).toBe(r.mrrCents * 12);
    expect(r.payingCustomers).toBeGreaterThanOrEqual(1);
    expect(await one("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='admin.revenue_viewed'", [admin.id])).toBeTruthy();
    process.env.ADMIN_EMAILS = "nobody@x.test";
    expect(await growth.isAdmin(plain.id)).toBe(false);
    delete process.env.ADMIN_EMAILS;
  });
});

describe("F-188/F-189 product analytics & viral loop", () => {
  it("tracks the guest funnel without PII and computes K-factor / second-share", async () => {
    const sender = await user("vs");
    await card.saveProfile(ctx(sender.id), { ...base, name: "바이럴센더" });
    const s = await handoff.createExchangeSession(ctx(sender.id), { capabilities: {}, group: false, context: {} });
    await handoff.openGuestLanding(s.token, ctx(null), "anon");
    const reply = await handoff.replyExchange(s.token, ctx(null), guestCard("새사용자"));
    const newbie = await user("vn");
    await handoff.claimGuest(ctx(newbie.id), reply.claimToken!);
    await handoff.createExchangeSession(ctx(newbie.id), { capabilities: {}, group: false, context: {} }); // second-generation share

    for (const name of ["exchange_created", "guest_landing_viewed", "guest_replied", "guest_claimed", "signup_completed", "profile_created"]) {
      expect(await one("SELECT 1 FROM product_events WHERE name=$1", [name])).toBeTruthy();
    }
    const props = await q<{ properties: Record<string, unknown> }>("SELECT properties FROM product_events WHERE created_at > now() - interval '1 hour'");
    expect(JSON.stringify(props)).not.toMatch(/@|게스트사|새사용자/);

    const v = await growth.viralReport(1, sender.id);
    expect(v).toMatchObject({ senders: 1, invitesSent: 1, claims: 1, claimedWhoShared: 1, kFactor: 1, secondShareRate: 1 });
    const admin = (await one<{ id: string }>("SELECT id FROM users WHERE is_platform_admin LIMIT 1"))!.id;
    const f = await growth.funnelReport(ctx(admin), 1);
    expect(f.funnels.guest!.map((x) => x.step)).toEqual(["guest_landing_viewed", "guest_replied", "guest_claimed", "exchange_created"]);
    expect(f.funnels.guest![1]!.events).toBeGreaterThan(0);
    // client events: allowlisted + sanitized
    await growth.trackClient(ctx(null), "anon-client", { name: "cta_clicked", props: { cta: "reply", email: "x@y.z" } });
    expect((await one<{ properties: object }>("SELECT properties FROM product_events WHERE name='cta_clicked' ORDER BY id DESC LIMIT 1"))!.properties).toEqual({ cta: "reply" });
    expect(() => growth.clientEventInput.parse({ name: "subscription_activated" })).toThrow();
    const cost = await growth.costReport(ctx(admin), 1);
    expect(cost.byType.some((x) => x.jobType === "ocr")).toBe(true);
  });
});

describe("F-181 feature flags", () => {
  it("targets users/orgs, rolls out by percentage, honors the kill switch, caches", async () => {
    const admin = (await one<{ id: string }>("SELECT id FROM users WHERE is_platform_admin LIMIT 1"))!.id;
    const u = await user("ff");
    await expect(growth.upsertFlag(ctx(u.id), "new_inbox", growth.flagInput.parse({}))).rejects.toMatchObject({ status: 403 });
    await growth.upsertFlag(ctx(admin), "new_inbox", growth.flagInput.parse({ enabled: true, allowUsers: [u.id] }));
    await growth.upsertFlag(ctx(admin), "server_only", growth.flagInput.parse({ enabled: true, rolloutPercent: 100, clientVisible: false }));
    expect(await growth.flagEnabled("new_inbox", { userId: u.id })).toBe(true);
    expect(await growth.flagEnabled("new_inbox", { userId: admin })).toBe(false);
    expect(await growth.flagEnabled("does_not_exist", { userId: u.id })).toBe(false);
    const client = await growth.flagsFor({ userId: u.id });
    expect(client.new_inbox).toBe(true);
    expect("server_only" in client).toBe(false);
    await growth.killFlag(ctx(admin), "new_inbox");
    expect(await growth.flagEnabled("new_inbox", { userId: u.id })).toBe(false);
    expect(await one("SELECT 1 FROM audit_logs WHERE action='flag.killed'")).toBeTruthy();
    // cache: a direct DB change is invisible until invalidation/TTL
    await q("UPDATE feature_flags SET killed=false WHERE key='new_inbox'");
    expect(await growth.flagEnabled("new_inbox", { userId: u.id })).toBe(false);
    growth.invalidateFlagCache();
    expect(await growth.flagEnabled("new_inbox", { userId: u.id })).toBe(true);
  });
});

describe("F-196 experiments", () => {
  it("assigns deterministically, records sticky exposures, measures conversions", async () => {
    const admin = (await one<{ id: string }>("SELECT id FROM users WHERE is_platform_admin LIMIT 1"))!.id;
    const key = `cta_${stamp}`;
    await growth.createExperiment(ctx(admin), growth.experimentInput.parse({ key, name: "CTA copy", variants: [{ key: "control", weight: 1 }, { key: "bold", weight: 1 }], primaryMetric: "cta_clicked" }));
    expect((await growth.assignment(key, { anonId: "a1" })).variant).toBeNull(); // draft → no exposure
    await growth.setExperimentStatus(ctx(admin), key, "running");
    const subjects = Array.from({ length: 40 }, (_, i) => `subj-${i}`);
    const assigned: Record<string, string | null> = {};
    for (const s of subjects) assigned[s] = (await growth.assignment(key, { anonId: s })).variant;
    for (const s of subjects.slice(0, 5)) expect((await growth.assignment(key, { anonId: s })).variant).toBe(assigned[s]);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM experiment_exposures WHERE experiment_key=$1", [key]))!.n).toBe(40);
    for (const s of subjects.filter((x) => assigned[x] === "bold")) await growth.trackClient(ctx(null), s, { name: "cta_clicked" });
    const r = await growth.experimentResults(ctx(admin), key);
    const bold = r.results.find((x) => x.variant === "bold")!;
    const control = r.results.find((x) => x.variant === "control")!;
    expect(bold.conversions).toBe(bold.exposures);
    expect(control.conversions).toBe(0);
    expect(bold.exposures + control.exposures).toBe(40);
  });
});

describe("F-031/F-032 audience variants & adaptive card", () => {
  it("guest landing shows the explicitly chosen / event audience variant; owner preview + adaptive confirm", async () => {
    const u = await user("var");
    const p = await card.saveProfile(ctx(u.id), {
      ...base,
      name: "변형",
      headline: "기본 소개",
      industries: ["헬스케어"],
      offers: ["병원 유통망", "의료 영상 AI", "시리즈A 투자 유치"],
      variants: [
        { audience: "investor", headline: "ARR 3배 성장 중인 의료 AI", isDefault: false },
        { audience: "customer", headline: "판독 시간을 절반으로", isDefault: true },
      ],
    });
    const s1 = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: { audience: "investor" } });
    const l1 = await handoff.openGuestLanding(s1.token, ctx(null), "a");
    expect(l1.sender.headline).toBe("ARR 3배 성장 중인 의료 AI");
    expect((l1.sender as any).audienceReason).toBe("explicit");
    const ev = await event.createEvent(ctx(u.id), { name: "데모데이" });
    await booth.updateEventSettings(ctx(u.id), ev.id, { audience: "investor" });
    const s2 = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: { eventId: ev.id } });
    expect((await handoff.openGuestLanding(s2.token, ctx(null), "b")).sender.headline).toBe("ARR 3배 성장 중인 의료 AI");
    const s3 = await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: {} });
    expect((await handoff.openGuestLanding(s3.token, ctx(null), "c")).sender.headline).toBe("판독 시간을 절반으로");

    const vc = await living.previewVariant(ctx(u.id), p.id, { explicit: null, eventId: ev.id });
    expect(vc).toMatchObject({ audience: "investor", reason: "event" });

    // adaptive: no LLM key → rules fallback, labeled, confirmable, never invents highlights
    const sug = await living.adaptiveSuggest(ctx(u.id), p.id, { context: "시리즈B 투자 검토 중인 VC 심사역" });
    expect(sug).toMatchObject({ audience: "investor", provenance: "rules", label: "AI 추론", needsConfirmation: true });
    expect([...sug.highlights].sort()).toEqual(["병원 유통망", "시리즈A 투자 유치", "의료 영상 AI"].sort());
    expect(sug.highlights[0]).toBe("시리즈A 투자 유치");
    const conf = await living.adaptiveConfirm(ctx(u.id), p.id, { audience: "investor", highlights: [...sug.highlights, "지어낸 항목"], makeDefault: false });
    expect(conf.highlights).not.toContain("지어낸 항목");
    // highlights survive a normal editor save and order the offers on the landing
    const full = (await card.loadProfile(p.id))!;
    await card.saveProfile(ctx(u.id), { ...base, name: full.name, headline: full.headline, industries: full.industries, offers: full.offers.map((o) => o.text), variants: full.variants.map((v) => ({ audience: v.audience as "investor", headline: (v.content as any).headline, isDefault: v.isDefault })) }, p.id);
    const l4 = await handoff.openGuestLanding((await handoff.createExchangeSession(ctx(u.id), { capabilities: {}, group: false, context: { audience: "investor" } })).token, ctx(null), "d");
    expect(l4.sender.offers[0]).toBe("시리즈A 투자 유치");
    await expect(living.adaptiveSuggest(ctx((await user()).id), p.id, {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("F-033 Living Update + inbox", () => {
  it("profile change → suggestion + notification for contact holders → accept updates contact with provenance sync", async () => {
    const a = await user("la");
    const b = await user("lb");
    await card.saveProfile(ctx(a.id), { ...base, name: "에이" });
    const pb = await card.saveProfile(ctx(b.id), { ...base, name: "비", company: "구회사", jobTitle: "매니저", fields: [{ type: "website", value: "https://old.example", visibility: "business" }, { type: "email", value: "b@private.test", visibility: "private" }] });
    const s = await handoff.createExchangeSession(ctx(a.id), { capabilities: {}, group: false, context: {} });
    await handoff.replyExchange(s.token, ctx(b.id), { card: { fullName: "비", company: "구회사", jobTitle: "매니저", website: "https://old.example" }, sharedFields: ["fullName", "company", "jobTitle", "website"], consent: { exchange: true }, provenance: {} });
    const contact = (await one<{ id: string }>("SELECT id FROM contacts WHERE owner_user_id=$1 AND linked_user_id=$2", [a.id, b.id]))!;
    while ((await relayOutbox()) > 0);

    await card.saveProfile(ctx(b.id), { ...base, name: "비", company: "새회사", jobTitle: "이사", fields: [{ type: "website", value: "https://new.example", visibility: "business" }] }, pb.id);
    while ((await relayOutbox()) > 0);
    const pending = await living.listLivingUpdates(a.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].changes.map((c: any) => c.field).sort()).toEqual(["company", "jobTitle", "website"]);
    expect(await inbox.unreadCount(a.id)).toBeGreaterThanOrEqual(1);
    const note = (await inbox.listNotifications(a.id)).find((x) => x.kind === "living_update")!;
    expect(note.body).toContain("이사");
    // a second change refreshes the same suggestion (no duplicates)
    await card.saveProfile(ctx(b.id), { ...base, name: "비", company: "새회사", jobTitle: "대표", fields: [{ type: "website", value: "https://new.example", visibility: "business" }] }, pb.id);
    while ((await relayOutbox()) > 0);
    const again = await living.listLivingUpdates(a.id);
    expect(again).toHaveLength(1);
    expect(again[0].changes.find((c: any) => c.field === "jobTitle").to).toBe("대표");
    expect((await inbox.listNotifications(a.id)).filter((x) => x.kind === "living_update")).toHaveLength(1);

    // another user cannot resolve it
    await expect(living.resolveLivingUpdate(ctx(b.id), again[0].id, { accept: true })).rejects.toMatchObject({ status: 404 });
    const r = await living.resolveLivingUpdate(ctx(a.id), again[0].id, { accept: true, fields: ["company", "jobTitle"] });
    expect(r.applied?.sort()).toEqual(["company", "jobTitle"]);
    const c = (await one<any>("SELECT c.job_title, co.name AS company, c.website, c.field_provenance FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.id=$1", [contact.id]))!;
    expect(c).toMatchObject({ job_title: "대표", company: "새회사", website: "https://old.example" });
    expect(c.field_provenance.jobTitle.source).toBe("sync");
    expect(await one("SELECT 1 FROM contact_field_history WHERE contact_id=$1 AND source='sync' AND field='jobTitle'", [contact.id])).toBeTruthy();
    expect(await living.listLivingUpdates(a.id)).toHaveLength(0);

    await inbox.markRead(ctx(a.id), "all");
    expect(await inbox.unreadCount(a.id)).toBe(0);
    await expect(inbox.markRead(ctx(b.id), note.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("F-036 Action Card CTAs", () => {
  it("owner enables CTAs; guests submit consented, rate-limited requests; owner gets an inbox item", async () => {
    const o = await user("act");
    const p = await card.saveProfile(ctx(o.id), { ...base, name: "액션" });
    expect((await living.getActionCtas(p.slug)).actions).toEqual([]);
    await living.setActionCtas(ctx(o.id), p.id, living.actionCtasInput.parse({ booking: { enabled: true, url: "https://cal.example/me" }, quote: { enabled: true } }));
    const ctas = await living.getActionCtas(p.slug);
    expect(ctas.actions.map((a) => a.kind)).toEqual(["booking", "quote"]);
    expect(ctas.actions[0]!.url).toBe("https://cal.example/me");
    await expect(living.setActionCtas(ctx((await user()).id), p.id, living.actionCtasInput.parse({}))).rejects.toMatchObject({ status: 404 });

    const req = living.actionRequestInput.parse({ kind: "quote", name: "구매담당", email: "Buyer@Corp.test", company: "코프", message: "100대 견적 부탁드립니다", details: { budget: "1천만원" }, consent: true });
    const r = await living.submitActionRequest(ctx(null, "10.9.9.9"), p.id, req);
    expect(r.status).toBe("new");
    const list = await living.listActionRequests(o.id);
    expect(list[0]).toMatchObject({ kind: "quote", requester_email: "buyer@corp.test", requester_company: "코프" });
    expect((await inbox.listNotifications(o.id))[0]).toMatchObject({ kind: "action_request" });
    expect(await one("SELECT 1 FROM card_action_requests WHERE id=$1 AND consent_policy_version IS NOT NULL", [r.id])).toBeTruthy();
    // disabled kind / no consent / honeypot
    await expect(living.submitActionRequest(ctx(null), p.id, { ...req, kind: "nda" })).rejects.toMatchObject({ status: 403 });
    expect(() => living.actionRequestInput.parse({ ...req, consent: false })).toThrow();
    expect(() => living.actionRequestInput.parse({ ...req, website: "spam" })).toThrow();
    // audit/analytics carry no requester PII
    expect(JSON.stringify(await q("SELECT metadata FROM audit_logs WHERE action='action_request.created'"))).not.toMatch(/corp\.test/i);
    // rate limit per IP
    delete process.env.RATE_LIMIT_DISABLED;
    const ip = `10.77.${stamp % 250}.1`;
    for (let i = 0; i < 10; i++) await living.submitActionRequest(ctx(null, ip), p.id, req);
    await expect(living.submitActionRequest(ctx(null, ip), p.id, req)).rejects.toMatchObject({ status: 429 });
    process.env.RATE_LIMIT_DISABLED = "1";
    expect(await living.updateActionRequest(ctx(o.id), r.id, "done")).toMatchObject({ status: "done" });
  });
});

describe("F-147/F-149/F-151 booth lead flow, ROI, organizer API", () => {
  it("captures, qualifies, assigns, exports leads; computes ROI; organizer API is token-scoped and opt-in only", async () => {
    const owner = await user("ev");
    const staff = await user("st");
    const outsider = await user("out");
    const attendee = await user("at");
    for (const u of [owner, staff, outsider, attendee]) await card.saveProfile(ctx(u.id), { ...base, name: `사람${u.id.slice(0, 4)}`, company: "회사", fields: [{ type: "email", value: `${u.id.slice(0, 6)}@hidden.test`, visibility: "business" }, { type: "website", value: "https://pub.example", visibility: "public" }] });
    const ev = await event.createEvent(ctx(owner.id), { name: "엑스포" });
    const code = (await one<{ join_code: string }>("SELECT join_code FROM events WHERE id=$1", [ev.id]))!.join_code;
    await event.joinEvent(ctx(staff.id), code, false);
    await event.joinEvent(ctx(attendee.id), code, true);
    await event.joinEvent(ctx(outsider.id), code, false);
    await booth.setStaff(ctx(owner.id), ev.id, staff.id, true);
    await expect(booth.setStaff(ctx(staff.id), ev.id, outsider.id, true)).rejects.toMatchObject({ status: 403 });

    const lead = await booth.captureLead(ctx(staff.id), ev.id, booth.leadInput.parse({ contact: { fullName: "=리드", company: "바이어사", email: "lead@buyer.test" }, qualifiers: ["budget", "need", "authority", "timeline"], interest: "hot", tags: ["의료"], assignedTo: owner.id }));
    expect(lead).toMatchObject({ grade: "A", score: 92, assigned_to: owner.id });
    expect((await inbox.listNotifications(owner.id)).some((x) => x.kind === "lead_assigned")).toBe(true);
    await expect(booth.captureLead(ctx(outsider.id), ev.id, booth.leadInput.parse({ contact: { fullName: "x" } }))).rejects.toMatchObject({ status: 403 });
    await expect(booth.captureLead(ctx(staff.id), ev.id, booth.leadInput.parse({ contact: { fullName: "y" }, assignedTo: outsider.id }))).rejects.toMatchObject({ code: "assignee_not_in_team" });
    const cold = await booth.captureLead(ctx(owner.id), ev.id, booth.leadInput.parse({ contact: { fullName: "콜드" } }));
    expect(cold.grade).toBe("C");
    expect(await booth.listLeads(ctx(owner.id), ev.id, { mine: true })).toHaveLength(1);

    await booth.updateLead(ctx(owner.id), lead.id, { stage: "won", dealValueCents: 500_000 });
    await booth.updateLead(ctx(staff.id), cold.id, { stage: "proposal", dealValueCents: 200_000, qualifiers: ["need"] });
    await booth.updateEventSettings(ctx(owner.id), ev.id, { costCents: 100_000 });
    const m = await one<{ id: string }>("INSERT INTO meetings (owner_user_id, title) VALUES ($1,'후속 미팅') RETURNING id", [staff.id]);
    await q("INSERT INTO meeting_participants (meeting_id, contact_id) VALUES ($1,$2)", [m!.id, lead.contact_id]);
    await q("INSERT INTO followups (owner_user_id, contact_id, title, status) VALUES ($1,$2,'감사','done'),($1,$2,'자료','open')", [staff.id, lead.contact_id]);
    const roi = await booth.eventRoiReport(ctx(owner.id), ev.id);
    expect(roi).toMatchObject({ leads: 2, meetingsBooked: 1, wonCents: 500_000, pipelineCents: 200_000, costPerLeadCents: 50_000, roiPct: 400 });
    expect(roi.followupCompletion).toBe(50);

    const csv = await booth.exportLeadsCsv(ctx(staff.id), ev.id);
    expect(csv.body).toContain("full_name,company");
    expect(csv.body).toContain("'=리드"); // formula injection guard
    expect(await one("SELECT 1 FROM audit_logs WHERE action='event.leads_exported' AND entity_id=$1", [ev.id])).toBeTruthy();
    await expect(booth.exportLeadsCsv(ctx(outsider.id), ev.id)).rejects.toMatchObject({ status: 403 });

    // organizer API
    await expect(booth.createOrganizerToken(ctx(staff.id), ev.id, { label: "badge", scopes: ["attendees:read"] })).rejects.toMatchObject({ status: 403 });
    const tok = await booth.createOrganizerToken(ctx(owner.id), ev.id, booth.tokenInput.parse({ label: "badge vendor" }));
    expect(tok.token).toMatch(/^lkev_/);
    expect(await one("SELECT 1 FROM event_api_tokens WHERE token_hash=$1", [tok.token])).toBeNull();
    const att = await booth.organizerAttendees(`Bearer ${tok.token}`, ev.id);
    const names = att.data.map((x) => x.name);
    expect(names).toContain(`사람${attendee.id.slice(0, 4)}`);
    expect(names).toContain(`사람${owner.id.slice(0, 4)}`); // organizer auto-opted in on create
    expect(names).not.toContain(`사람${staff.id.slice(0, 4)}`); // opt_in=false
    expect(JSON.stringify(att)).not.toContain("@hidden.test");
    expect(att.data[0]!.publicFields).toEqual([{ type: "website", value: "https://pub.example" }]);
    const leads = await booth.organizerLeads(`Bearer ${tok.token}`, ev.id);
    expect(leads.data).toHaveLength(2);
    expect((await booth.organizerLeads(`Bearer ${tok.token}`, ev.id, "csv")).csv).toContain("lead@buyer.test");
    const other = await event.createEvent(ctx(owner.id), { name: "다른 행사" });
    await expect(booth.organizerAttendees(`Bearer ${tok.token}`, other.id)).rejects.toMatchObject({ status: 401 });
    await expect(booth.organizerAttendees("Bearer lkev_invalidinvalidinvalidinvalid", ev.id)).rejects.toMatchObject({ status: 401 });
    const narrow = await booth.createOrganizerToken(ctx(owner.id), ev.id, { label: "attendees only", scopes: ["attendees:read"] });
    await expect(booth.organizerLeads(`Bearer ${narrow.token}`, ev.id)).rejects.toMatchObject({ status: 403 });
    await booth.revokeOrganizerToken(ctx(owner.id), ev.id, tok.id);
    await expect(booth.organizerAttendees(`Bearer ${tok.token}`, ev.id)).rejects.toMatchObject({ status: 401 });
  });
});

describe("F-180 tracing", () => {
  it("is a no-op without an endpoint; with OTLP endpoint propagates traceparent and exports server + db spans", async () => {
    expect(tracing.tracingEnabled()).toBe(false);
    expect(await tracing.withSpan("noop", {}, async (s) => s)).toBeUndefined();
    expect(tracing.parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01")).toBeNull();
    expect(tracing.parseTraceparent("garbage")).toBeNull();

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=secret";
    try {
      const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      let serverSpanId = "";
      await tracing.withSpan("GET /api/v1/home", { "http.method": "GET" }, async (span) => {
        serverSpanId = span!.spanId;
        expect(tracing.formatTraceparent(span!)).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
        await q("SELECT 1");
      }, { kind: "server", traceparent: parent });
      // DB query outside any request: no orphan span
      await q("SELECT 2");
      expect(await tracing.flushSpans()).toBe(2);
      const body = otlp.at(-1)!.body;
      expect(otlp.at(-1)!.url).toBe("/v1/traces");
      const spans = body.resourceSpans[0].scopeSpans[0].spans;
      const server = spans.find((s: any) => s.kind === 2);
      const db = spans.find((s: any) => s.name === "db.query");
      expect(server.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(server.parentSpanId).toBe("00f067aa0ba902b7");
      expect(db.parentSpanId).toBe(serverSpanId);
      expect(db.attributes.find((a: any) => a.key === "db.statement").value.stringValue).toBe("SELECT 1");
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    }
  });
});
