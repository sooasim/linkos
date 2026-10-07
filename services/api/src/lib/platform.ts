// 공통 플랫폼 기능: outbox, audit, rate limit, idempotency, 구조화 로그(PII 리댁션)
import { createHash, createHmac } from "node:crypto";
import type { DomainEventName, DomainEvents } from "@linkos/domain";
import { redact } from "@linkos/domain";
import { type Db, one, pool, q } from "./db";
import { tooMany } from "./errors";
import { currentTraceId } from "./tracing";

export interface Ctx {
  userId: string | null;
  ip: string;
  userAgent: string;
  requestId: string;
}

export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  const traceId = currentTraceId();
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(traceId ? { trace_id: traceId } : {}), ...(data ? (redact(data) as object) : {}) });
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.NODE_ENV !== "test") console.log(line);
}

/** Transactional outbox: call with the same client used for the domain write. */
export async function emit<E extends DomainEventName>(
  db: Db,
  event: E,
  aggregateType: string,
  aggregateId: string,
  payload: DomainEvents[E],
): Promise<void> {
  await db.query(
    "INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2,$3,$4)",
    [aggregateType, aggregateId, event, JSON.stringify(payload)],
  );
}

export async function audit(
  db: Db,
  ctx: Pick<Ctx, "userId">,
  action: string,
  entityType: string | null,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  organizationId: string | null = null,
): Promise<void> {
  await db.query(
    "INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)",
    [organizationId, ctx.userId, action, entityType, entityId, JSON.stringify(redact(metadata))],
  );
}

/** Fixed-window rate limit stored in Postgres (works across instances). */
export async function rateLimit(bucket: string, limit: number, windowSec: number): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === "1") return;
  const now = Date.now();
  const windowStart = new Date(now - (now % (windowSec * 1000)));
  const row = await one<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1,$2,1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, windowStart],
  );
  if ((row?.count ?? 0) > limit) {
    const retry = Math.ceil((windowStart.getTime() + windowSec * 1000 - now) / 1000);
    throw tooMany(retry);
  }
  if (Math.random() < 0.01) {
    void q("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'").catch(() => undefined);
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hmac(s: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is required in production");
  return createHmac("sha256", secret ?? "dev-only-secret").update(s).digest("hex");
}

/** Idempotency-Key format accepted by the API (UUIDs and similar opaque client ids). */
export function isValidIdempotencyKey(key: string | null | undefined): key is string {
  return !!key && /^[A-Za-z0-9_.:-]{8,128}$/.test(key);
}

/**
 * Look up a cached response for (scope, key). Throws 409 when the key is reused with a different body.
 * Cached bodies are sealed with AES-256-GCM (audit G-05): responses may carry one-time secrets such as
 * exchange/claim tokens, which must never sit in the database in plain text.
 */
export async function idempotencyLookup<T>(scope: string, key: string, requestBody: unknown): Promise<{ status: number; body: T } | null> {
  const reqHash = sha256(JSON.stringify(requestBody ?? null));
  const existing = await one<{ request_hash: string; status_code: number; response: any }>(
    "SELECT request_hash, status_code, response FROM idempotency_keys WHERE scope=$1 AND key=$2",
    [scope, key],
  );
  if (!existing) return null;
  if (existing.request_hash !== reqHash) {
    const { conflict } = await import("./errors");
    throw conflict("idempotency_key_reused", "같은 Idempotency-Key 로 다른 요청을 보낼 수 없습니다.");
  }
  const { unseal } = await import("./vault");
  const body = existing.response && typeof existing.response === "object" && typeof existing.response.sealed === "string" ? unseal<T>(Buffer.from(existing.response.sealed, "base64")) : (existing.response as T);
  return { status: existing.status_code, body };
}

export async function idempotencyStore(scope: string, key: string, requestBody: unknown, status: number, body: unknown): Promise<void> {
  const { seal } = await import("./vault");
  await pool().query(
    "INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [scope, key, sha256(JSON.stringify(requestBody ?? null)), status, JSON.stringify({ sealed: seal(body ?? null).toString("base64") })],
  );
}

/** Idempotency-Key support for create/update APIs (백서 11). */
export async function withIdempotency<T>(
  scope: string,
  key: string | null,
  requestBody: unknown,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  const hit = await idempotencyLookup<T>(scope, key, requestBody);
  if (hit) return { ...hit, replayed: true };
  const res = await run();
  await idempotencyStore(scope, key, requestBody, res.status, res.body);
  return { ...res, replayed: false };
}

export function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

// ---------- F-180 metrics (in-process, Prometheus text format) ----------
const BUCKETS = [25, 50, 100, 200, 300, 400, 800, 1500, 3000, 8000];
const reqs = new Map<string, { count: number; errors: number; sum: number; buckets: number[] }>();

export function routeKey(method: string, path: string): string {
  const p = path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/[A-Za-z0-9_-]{20,}/g, "/:token")
    .replace(/\/(c|sessions)\/[2-9A-Z]{6}(?=\/|$)/g, "/$1/:code");
  return `${method} ${p}`;
}

export function recordRequest(key: string, status: number, ms: number): void {
  let r = reqs.get(key);
  if (!r) {
    if (reqs.size > 500) return; // cardinality guard
    r = { count: 0, errors: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    reqs.set(key, r);
  }
  r.count++;
  if (status >= 500) r.errors++;
  r.sum += ms;
  BUCKETS.forEach((b, i) => {
    if (ms <= b) r!.buckets[i]!++;
  });
}

export function renderMetrics(): string {
  const lines = ["# TYPE linkos_http_request_duration_ms histogram", "# TYPE linkos_http_errors_total counter"];
  for (const [key, r] of reqs) {
    const label = `route="${key.replace(/"/g, "'")}"`;
    BUCKETS.forEach((b, i) => lines.push(`linkos_http_request_duration_ms_bucket{${label},le="${b}"} ${r.buckets[i]}`));
    lines.push(`linkos_http_request_duration_ms_bucket{${label},le="+Inf"} ${r.count}`);
    lines.push(`linkos_http_request_duration_ms_sum{${label}} ${r.sum.toFixed(1)}`);
    lines.push(`linkos_http_request_duration_ms_count{${label}} ${r.count}`);
    lines.push(`linkos_http_errors_total{${label}} ${r.errors}`);
  }
  return lines.join("\n") + "\n";
}
