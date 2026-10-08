// growth module — F-181 Feature Flag, F-196 실험 프레임워크, F-188 제품 분석 퍼널, F-189 바이럴 계수, F-187 비용 리포트, 관리자 권한
import {
  CLIENT_EVENTS,
  type FlagDef,
  type FlagSubject,
  PRODUCT_EVENTS,
  type ProductEventName,
  assignVariant,
  evaluateFlag,
  experimentStats,
  viralMetrics,
} from "@linkos/domain";
import { z } from "zod";
import { one, pool, q } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { type Subject, subjectKey, track } from "../lib/metering";
import { type Ctx, audit, rateLimit } from "../lib/platform";
import { enterpriseActiveRelationships, matchToMeetingKpi, retentionKpi, webVitalsKpi } from "./analytics";

// ---------- admin ----------
function adminEmails(): Set<string> {
  return new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export async function isAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const u = await one<{ email: string | null; is_platform_admin: boolean }>("SELECT email, is_platform_admin FROM users WHERE id=$1 AND status='active'", [userId]);
  if (!u) return false;
  return u.is_platform_admin || (!!u.email && adminEmails().has(u.email.toLowerCase()));
}

export async function requireAdmin(ctx: Ctx): Promise<string> {
  if (!ctx.userId) throw unauthorized();
  if (!(await isAdmin(ctx.userId))) throw forbidden("관리자만 접근할 수 있습니다.");
  return ctx.userId;
}

// ---------- F-181 feature flags (DB-backed, cached per process) ----------
interface FlagRow {
  key: string;
  description: string | null;
  enabled: boolean;
  killed: boolean;
  rollout_percent: number;
  allow_users: string[];
  allow_orgs: string[];
  deny_users: string[];
  client_visible: boolean;
  updated_at: Date;
}
type CachedFlag = FlagDef & { clientVisible: boolean };
let flagCache: { at: number; flags: Map<string, CachedFlag> } | null = null;

const toDef = (r: FlagRow): CachedFlag => ({
  key: r.key,
  enabled: r.enabled,
  killed: r.killed,
  rolloutPercent: r.rollout_percent,
  allowUsers: r.allow_users,
  allowOrgs: r.allow_orgs,
  denyUsers: r.deny_users,
  clientVisible: r.client_visible,
});

export function invalidateFlagCache() {
  flagCache = null;
}

async function loadFlags(): Promise<Map<string, CachedFlag>> {
  const ttl = Number(process.env.FLAG_CACHE_TTL_MS ?? 30_000);
  if (flagCache && Date.now() - flagCache.at < ttl) return flagCache.flags;
  const rows = await q<FlagRow>("SELECT * FROM feature_flags");
  flagCache = { at: Date.now(), flags: new Map(rows.map((r) => [r.key, toDef(r)])) };
  return flagCache.flags;
}

async function orgIdsFor(userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  return (await q<{ organization_id: string }>("SELECT organization_id FROM organization_members WHERE user_id=$1 AND status='active'", [userId])).map((r) => r.organization_id);
}

/** Server helper: is `key` on for this subject? Unknown flags are off. */
export async function flagEnabled(key: string, subject: FlagSubject): Promise<boolean> {
  const f = (await loadFlags()).get(key);
  if (!f) return false;
  const orgIds = subject.orgIds ?? (f.allowOrgs.length ? await orgIdsFor(subject.userId) : []);
  return evaluateFlag(f, { ...subject, orgIds }).on;
}

/** GET /flags — evaluated client-visible flags for the viewer (signed in or anonymous). */
export async function flagsFor(subject: FlagSubject, clientOnly = true): Promise<Record<string, boolean>> {
  const flags = await loadFlags();
  const orgIds = subject.orgIds ?? (await orgIdsFor(subject.userId));
  const out: Record<string, boolean> = {};
  for (const f of flags.values()) if (!clientOnly || f.clientVisible) out[f.key] = evaluateFlag(f, { ...subject, orgIds }).on;
  return out;
}

const KEY = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
export const flagInput = z.object({
  description: z.string().max(300).nullish(),
  enabled: z.boolean().default(false),
  killed: z.boolean().default(false),
  rolloutPercent: z.number().int().min(0).max(100).default(0),
  allowUsers: z.array(z.string().uuid()).max(500).default([]),
  allowOrgs: z.array(z.string().uuid()).max(500).default([]),
  denyUsers: z.array(z.string().uuid()).max(500).default([]),
  clientVisible: z.boolean().default(true),
});

export async function listFlags(ctx: Ctx) {
  await requireAdmin(ctx);
  return q<FlagRow>("SELECT * FROM feature_flags ORDER BY key");
}

export async function upsertFlag(ctx: Ctx, key: string, input: z.infer<typeof flagInput>) {
  const uid = await requireAdmin(ctx);
  KEY.parse(key);
  const r = await one<FlagRow>(
    `INSERT INTO feature_flags (key, description, enabled, killed, rollout_percent, allow_users, allow_orgs, deny_users, client_visible, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description, enabled=EXCLUDED.enabled, killed=EXCLUDED.killed, rollout_percent=EXCLUDED.rollout_percent,
       allow_users=EXCLUDED.allow_users, allow_orgs=EXCLUDED.allow_orgs, deny_users=EXCLUDED.deny_users, client_visible=EXCLUDED.client_visible,
       updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING *`,
    [key, input.description ?? null, input.enabled, input.killed, input.rolloutPercent, input.allowUsers, input.allowOrgs, input.denyUsers, input.clientVisible, uid],
  );
  invalidateFlagCache();
  await audit(pool(), ctx, input.killed ? "flag.killed" : "flag.updated", "feature_flag", null, { key, enabled: input.enabled, rollout: input.rolloutPercent, killed: input.killed });
  return r;
}

/** Kill switch: flips a flag off for everyone immediately (this process) and within the cache TTL elsewhere. */
export async function killFlag(ctx: Ctx, key: string, killed = true) {
  await requireAdmin(ctx);
  const r = await one<FlagRow>("UPDATE feature_flags SET killed=$2, updated_by=$3, updated_at=now() WHERE key=$1 RETURNING *", [key, killed, ctx.userId]);
  if (!r) throw notFound("flag");
  invalidateFlagCache();
  await audit(pool(), ctx, killed ? "flag.killed" : "flag.revived", "feature_flag", null, { key });
  return r;
}

// ---------- F-196 experiments ----------
interface ExperimentRow {
  key: string;
  name: string;
  hypothesis: string | null;
  status: "draft" | "running" | "stopped";
  variants: { key: string; weight: number }[];
  traffic_percent: number;
  primary_metric: string;
  started_at: Date | null;
  stopped_at: Date | null;
  created_at: Date;
}

export const experimentInput = z.object({
  key: KEY,
  name: z.string().trim().min(1).max(120),
  hypothesis: z.string().max(1000).nullish(),
  variants: z
    .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), weight: z.number().min(0).max(1000) }))
    .min(2)
    .max(6)
    .refine((v) => new Set(v.map((x) => x.key)).size === v.length, "variant keys must be unique"),
  trafficPercent: z.number().int().min(0).max(100).default(100),
  primaryMetric: z.enum(PRODUCT_EVENTS),
});

export async function createExperiment(ctx: Ctx, input: z.infer<typeof experimentInput>) {
  const uid = await requireAdmin(ctx);
  const r = await one<ExperimentRow>(
    `INSERT INTO experiments (key, name, hypothesis, variants, traffic_percent, primary_metric, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO NOTHING RETURNING *`,
    [input.key, input.name, input.hypothesis ?? null, JSON.stringify(input.variants), input.trafficPercent, input.primaryMetric, uid],
  );
  if (!r) throw conflict("experiment_exists", "같은 key 의 실험이 이미 있습니다.");
  await audit(pool(), ctx, "experiment.created", "experiment", null, { key: input.key });
  return r;
}

export async function setExperimentStatus(ctx: Ctx, key: string, status: "running" | "stopped") {
  await requireAdmin(ctx);
  const r = await one<ExperimentRow>(
    `UPDATE experiments SET status=$2, started_at = CASE WHEN $2='running' THEN COALESCE(started_at, now()) ELSE started_at END,
       stopped_at = CASE WHEN $2='stopped' THEN now() ELSE NULL END WHERE key=$1 RETURNING *`,
    [key, status],
  );
  if (!r) throw notFound("experiment");
  expCache.delete(key);
  await audit(pool(), ctx, `experiment.${status}`, "experiment", null, { key });
  return r;
}

const expCache = new Map<string, { at: number; row: ExperimentRow | null }>();
async function getExperiment(key: string): Promise<ExperimentRow | null> {
  const hit = expCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.row;
  const row = await one<ExperimentRow>("SELECT * FROM experiments WHERE key=$1", [key]);
  expCache.set(key, { at: Date.now(), row });
  return row;
}

/**
 * GET /experiments/{key}/assignment — deterministic variant + sticky exposure record.
 * Not running / not enrolled → { variant: null } (show the default experience, no exposure).
 */
export async function assignment(key: string, subject: Subject): Promise<{ experiment: string; variant: string | null }> {
  const exp = await getExperiment(key);
  const sk = subjectKey(subject);
  if (!exp || exp.status !== "running" || !sk) return { experiment: key, variant: null };
  const v = assignVariant({ key: exp.key, variants: exp.variants, trafficPercent: exp.traffic_percent }, sk);
  if (!v) return { experiment: key, variant: null };
  const ins = await one<{ variant: string }>(
    "INSERT INTO experiment_exposures (experiment_key, subject_key, variant) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING variant",
    [exp.key, sk, v],
  );
  if (ins) await track(null, "experiment_exposed", subject, { experiment: exp.key, variant: v });
  else {
    // sticky: keep the first exposure even if weights changed later
    const prev = await one<{ variant: string }>("SELECT variant FROM experiment_exposures WHERE experiment_key=$1 AND subject_key=$2", [exp.key, sk]);
    return { experiment: key, variant: prev?.variant ?? v };
  }
  return { experiment: key, variant: v };
}

export async function listExperiments(ctx: Ctx) {
  await requireAdmin(ctx);
  return q<ExperimentRow & { exposures: number }>(
    "SELECT e.*, (SELECT count(*)::int FROM experiment_exposures x WHERE x.experiment_key=e.key) AS exposures FROM experiments e ORDER BY e.created_at DESC",
  );
}

/** Conversions = exposed subjects who emitted the primary metric event after their first exposure. */
export async function experimentResults(ctx: Ctx, key: string) {
  await requireAdmin(ctx);
  const exp = await one<ExperimentRow>("SELECT * FROM experiments WHERE key=$1", [key]);
  if (!exp) throw notFound("experiment");
  const rows = await q<{ variant: string; exposures: number; conversions: number }>(
    `SELECT x.variant, count(*)::int AS exposures,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM product_events pe WHERE pe.subject_key = x.subject_key AND pe.name = $2 AND pe.created_at >= x.first_exposed_at))::int AS conversions
     FROM experiment_exposures x WHERE x.experiment_key=$1 GROUP BY x.variant`,
    [key, exp.primary_metric],
  );
  const ordered = exp.variants.map((v) => rows.find((r) => r.variant === v.key) ?? { variant: v.key, exposures: 0, conversions: 0 });
  return { experiment: exp, results: experimentStats(ordered, exp.variants[0]?.key) };
}

// ---------- F-188 product analytics ----------
export const clientEventInput = z.object({
  name: z.enum(CLIENT_EVENTS as unknown as [ProductEventName, ...ProductEventName[]]),
  props: z.record(z.string(), z.unknown()).optional(),
});

/** POST /analytics/events — browser-originated events (allowlisted names, sanitized props, rate limited). */
export async function trackClient(ctx: Ctx, anonId: string | null, input: z.infer<typeof clientEventInput>) {
  if (!(CLIENT_EVENTS as readonly string[]).includes(input.name)) throw badRequest("event_not_allowed");
  await rateLimit(`analytics:${ctx.userId ?? ctx.ip}`, 300, 3600);
  await track(pool(), input.name, { userId: ctx.userId, anonId }, input.props);
  return { ok: true };
}

const FUNNELS: Record<string, ProductEventName[]> = {
  guest: ["guest_landing_viewed", "guest_replied", "guest_claimed", "exchange_created"],
  activation: ["signup_completed", "profile_created", "exchange_created"],
  monetization: ["usage_limit_hit", "checkout_started", "subscription_activated"],
};

/** Admin funnel: distinct subjects per step (event counts for the per-session guest steps), plus daily series from the view. */
export async function funnelReport(ctx: Ctx, days = 30) {
  await requireAdmin(ctx);
  const counts = await q<{ name: string; events: number; subjects: number }>(
    "SELECT name, count(*)::int AS events, count(DISTINCT subject_key)::int AS subjects FROM product_events WHERE created_at > now() - make_interval(days => $1) GROUP BY name",
    [days],
  );
  const by = new Map(counts.map((c) => [c.name, c]));
  const funnels = Object.fromEntries(
    Object.entries(FUNNELS).map(([k, steps]) => [
      k,
      steps.map((s, i) => {
        const n = by.get(s)?.events ?? 0;
        const prev = i ? (by.get(steps[i - 1]!)?.events ?? 0) : null;
        return { step: s, events: n, subjects: by.get(s)?.subjects ?? 0, conversionFromPrev: prev ? Math.round((n / prev) * 1000) / 10 : null };
      }),
    ]),
  );
  const daily = await q<{ day: string; name: string; events: number; subjects: number }>(
    "SELECT day::text, name, events, subjects FROM product_funnel_daily WHERE day > (now() - make_interval(days => $1))::date ORDER BY day",
    [days],
  );
  return { windowDays: days, funnels, daily };
}

/** F-189 viral loop from exchange/claim records (cohort = sessions created in the window). */
export async function viralReport(days = 30, senderUserId?: string) {
  const scope = senderUserId ? "AND s.sender_user_id = $2" : "";
  const params: unknown[] = [days];
  if (senderUserId) params.push(senderUserId);
  const r = await one<any>(
    `WITH cohort AS (SELECT s.* FROM exchange_sessions s WHERE s.created_at > now() - make_interval(days => $1) ${scope}),
     claims AS (SELECT DISTINCT g.claimed_user_id AS uid, g.claimed_at FROM guest_claims g JOIN cohort s ON s.id = g.exchange_session_id WHERE g.claimed_user_id IS NOT NULL),
     later AS (SELECT x.sender_user_id, count(*)::int AS n FROM exchange_sessions x JOIN claims c ON c.uid = x.sender_user_id AND x.created_at > c.claimed_at GROUP BY 1)
     SELECT
       (SELECT count(DISTINCT sender_user_id)::int FROM cohort) AS senders,
       (SELECT count(*)::int FROM cohort) AS invites_sent,
       (SELECT count(*)::int FROM cohort WHERE receiver_opened_at IS NOT NULL) AS invites_opened,
       (SELECT COALESCE(sum(use_count),0)::int FROM cohort) AS replies,
       (SELECT count(*)::int FROM claims) AS claims,
       (SELECT count(*)::int FROM later) AS claimed_who_shared,
       (SELECT COALESCE(sum(n),0)::int FROM later) AS shares_by_claimed`,
    params,
  );
  const input = {
    senders: r.senders,
    invitesSent: r.invites_sent,
    invitesOpened: r.invites_opened,
    replies: r.replies,
    claims: r.claims,
    claimedWhoShared: r.claimed_who_shared,
    sharesByClaimed: r.shares_by_claimed,
  };
  return { windowDays: days, ...input, ...viralMetrics(input) };
}

export async function adminViral(ctx: Ctx, days = 30) {
  await requireAdmin(ctx);
  return viralReport(days);
}

/** F-187: estimated cost by job type and top tenants (ids only — no contact data). */
export async function costReport(ctx: Ctx, days = 30) {
  await requireAdmin(ctx);
  const byType = await q<{ job_type: string; provider: string; units: string; cost_micros: string; n: number }>(
    `SELECT job_type, provider, sum(units)::text AS units, sum(cost_micros)::text AS cost_micros, count(*)::int AS n
     FROM cost_ledger WHERE created_at > now() - make_interval(days => $1) GROUP BY 1,2 ORDER BY sum(cost_micros) DESC`,
    [days],
  );
  const tenants = await q<{ tenant: string; kind: string; cost_micros: string; n: number }>(
    `SELECT COALESCE(organization_id, user_id)::text AS tenant, CASE WHEN organization_id IS NOT NULL THEN 'organization' ELSE 'user' END AS kind,
       sum(cost_micros)::text AS cost_micros, count(*)::int AS n
     FROM cost_ledger WHERE created_at > now() - make_interval(days => $1) AND (user_id IS NOT NULL OR organization_id IS NOT NULL)
     GROUP BY 1,2 ORDER BY sum(cost_micros) DESC LIMIT 20`,
    [days],
  );
  const usd = (m: string | number) => Math.round(Number(m) / 10_000) / 100;
  return {
    windowDays: days,
    totalUsd: usd(byType.reduce((a, r) => a + Number(r.cost_micros), 0)),
    byType: byType.map((r) => ({ jobType: r.job_type, provider: r.provider, units: Number(r.units), jobs: r.n, usd: usd(r.cost_micros) })),
    topTenants: tenants.map((t) => ({ tenant: t.tenant, kind: t.kind, jobs: t.n, usd: usd(t.cost_micros) })),
  };
}

/**
 * 백서 §23 KPIs for platform admins (F-188): Retention (월간 관계 행동 재사용), Match-to-Meeting, Enterprise Active
 * Relationships, plus §20 RUM p75 (guest landing LCP). Computed from existing tables; counts only, no PII.
 */
export async function kpiReport(ctx: Ctx, days = 30) {
  await requireAdmin(ctx);
  const [retention, matchToMeeting, activeRelationships, webVitals] = await Promise.all([
    retentionKpi(null, days),
    matchToMeetingKpi(null, days),
    enterpriseActiveRelationships(null, days),
    webVitalsKpi(days),
  ]);
  return { windowDays: days, retention, matchToMeeting, enterpriseActiveRelationships: activeRelationships, webVitals };
}
