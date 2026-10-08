// webhooks module — F-123 Webhook/Zapier/Make: 사용자가 등록한 URL로 도메인 이벤트를 전달.
// HMAC-SHA256 서명(LINKOS-Signature: t=,v1=), 지수 백오프 재시도, 전달 로그, 테스트 전송. SSRF 방지(사설망/메타데이터 주소 차단, DNS 재확인).
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS, generateToken, isPrivateAddress, isRetryableStatus, validateWebhookUrl, webhookRetryDelaySec, webhookSigningInput } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { one, pool, q } from "../lib/db";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, log } from "../lib/platform";
import { seal, unseal } from "./integration";

const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1";
const AUTO_DISABLE_AFTER = 20;

export const endpointInput = z.object({
  url: z.string().trim().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS as [string, ...string[]])).min(1).max(WEBHOOK_EVENTS.length),
  description: z.string().trim().max(200).nullish(),
});
export const endpointPatch = z.object({ url: z.string().trim().max(2000).optional(), events: endpointInput.shape.events.optional(), description: z.string().trim().max(200).nullish(), active: z.boolean().optional() });

function checkUrl(url: string) {
  const v = validateWebhookUrl(url, { allowPrivate: allowPrivate() });
  if (!v.ok) throw badRequest("invalid_webhook_url", `웹훅 URL을 사용할 수 없습니다 (${v.reason}).`);
  return v.url.toString();
}

function dto(r: any) {
  return { id: r.id, url: r.url, description: r.description, events: r.events, active: r.active, consecutiveFailures: r.consecutive_failures, disabledReason: r.disabled_reason, createdAt: r.created_at };
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(webhookSigningInput(timestamp, body)).digest("hex");
}

export async function listEndpoints(userId: string) {
  const rows = await q<any>("SELECT * FROM webhook_endpoints WHERE owner_user_id=$1 ORDER BY created_at DESC", [userId]);
  const stats = await q<{ endpoint_id: string; status: string; n: number }>(
    "SELECT d.endpoint_id, d.status, count(*)::int AS n FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE e.owner_user_id=$1 AND d.created_at > now() - interval '7 days' GROUP BY 1,2",
    [userId],
  );
  return { events: WEBHOOK_EVENTS, endpoints: rows.map((r) => ({ ...dto(r), last7d: Object.fromEntries(stats.filter((s) => s.endpoint_id === r.id).map((s) => [s.status, s.n])) })) };
}

/** The signing secret is shown exactly once (on create / rotate). */
export async function createEndpoint(ctx: Ctx, input: z.infer<typeof endpointInput>) {
  if (!ctx.userId) throw unauthorized();
  const url = checkUrl(input.url);
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM webhook_endpoints WHERE owner_user_id=$1", [ctx.userId]);
  if ((count?.n ?? 0) >= 10) throw badRequest("too_many_endpoints", "웹훅은 최대 10개까지 등록할 수 있습니다.");
  const secret = `whsec_${generateToken(24)}`;
  const r = await one<any>("INSERT INTO webhook_endpoints (owner_user_id, url, description, events, secret_sealed) VALUES ($1,$2,$3,$4,$5) RETURNING *", [ctx.userId, url, input.description ?? null, input.events, seal({ s: secret })]);
  await audit(pool(), ctx, "webhook.created", null, r.id, { host: new URL(url).host, events: input.events });
  return { ...dto(r), secret };
}

export async function updateEndpoint(ctx: Ctx, id: string, patch: z.infer<typeof endpointPatch>) {
  if (!ctx.userId) throw unauthorized();
  const url = patch.url ? checkUrl(patch.url) : null;
  const r = await one<any>(
    `UPDATE webhook_endpoints SET url=COALESCE($3,url), events=COALESCE($4,events), description=COALESCE($5,description), active=COALESCE($6,active),
       consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures END, disabled_reason = CASE WHEN $6 THEN NULL ELSE disabled_reason END, updated_at=now()
     WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [id, ctx.userId, url, patch.events ?? null, patch.description ?? null, patch.active ?? null],
  );
  if (!r) throw notFound("webhook");
  await audit(pool(), ctx, "webhook.updated", null, id);
  return dto(r);
}

export async function rotateSecret(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const secret = `whsec_${generateToken(24)}`;
  const r = await one<any>("UPDATE webhook_endpoints SET secret_sealed=$3, updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *", [id, ctx.userId, seal({ s: secret })]);
  if (!r) throw notFound("webhook");
  await audit(pool(), ctx, "webhook.secret_rotated", null, id);
  return { ...dto(r), secret };
}

export async function deleteEndpoint(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("DELETE FROM webhook_endpoints WHERE id=$1 AND owner_user_id=$2 RETURNING id", [id, ctx.userId]);
  if (!r) throw notFound("webhook");
  await audit(pool(), ctx, "webhook.deleted", null, id);
  return { ok: true };
}

export async function listDeliveries(ctx: Ctx, endpointId: string) {
  if (!ctx.userId) throw unauthorized();
  const e = await one("SELECT 1 FROM webhook_endpoints WHERE id=$1 AND owner_user_id=$2", [endpointId, ctx.userId]);
  if (!e) throw notFound("webhook");
  return q("SELECT id, event_type, status, attempt_count, response_status, last_error, next_attempt_at, delivered_at, created_at FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at DESC LIMIT 100", [endpointId]);
}

export async function redeliver(ctx: Ctx, deliveryId: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<{ id: string }>(
    "UPDATE webhook_deliveries d SET status='queued', attempt_count=0, next_attempt_at=now(), last_error=NULL FROM webhook_endpoints e WHERE d.id=$1 AND e.id=d.endpoint_id AND e.owner_user_id=$2 AND d.status IN ('dead','delivered') RETURNING d.id",
    [deliveryId, ctx.userId],
  );
  if (!r) throw notFound("delivery");
  await processWebhookDeliveries(5, deliveryId);
  return one("SELECT id, status, attempt_count, response_status, last_error FROM webhook_deliveries WHERE id=$1", [deliveryId]);
}

/** Sends a signed `webhook.test` event right away and returns the receiver's response status. */
export async function testEndpoint(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<{ id: string }>("SELECT id FROM webhook_endpoints WHERE id=$1 AND owner_user_id=$2", [id, ctx.userId]);
  if (!e) throw notFound("webhook");
  const d = await one<{ id: string }>("INSERT INTO webhook_deliveries (endpoint_id, event_type, payload) VALUES ($1,'webhook.test',$2) RETURNING id", [id, JSON.stringify({ message: "LINKOS webhook test", endpoint_id: id })]);
  await processWebhookDeliveries(1, d!.id);
  return one("SELECT id, status, attempt_count, response_status, last_error FROM webhook_deliveries WHERE id=$1", [d!.id]);
}

/** Which user owns a domain event (webhooks are per user). Uses the caller's transaction client. */
async function eventOwner(c: pg.PoolClient, type: string, p: any): Promise<string | null> {
  const first = async (sql: string, params: unknown[]) => ((await c.query<{ u: string }>(sql, params)).rows[0]?.u ?? null);
  switch (type) {
    case "contact.updated":
      return first("SELECT owner_user_id AS u FROM contacts WHERE id=$1", [p.contact_id]);
    case "followup.due":
      return p.user_id ?? null;
    case "exchange.session.created":
      return p.sender_id ?? null;
    case "exchange.channel.attempted":
    case "exchange.receiver.opened":
      return first("SELECT sender_user_id AS u FROM exchange_sessions WHERE id=$1", [p.session_id]);
    case "exchange.completed":
      return first("SELECT owner_user_id AS u FROM encounters WHERE id=$1", [p.encounter_id]);
    case "guest.claimed":
      return p.user_id ?? null;
    case "card.extraction.completed":
      return first("SELECT captured_by AS u FROM business_cards WHERE id=$1", [p.card_id]);
    case "profile.updated":
      return first("SELECT user_id AS u FROM profiles WHERE id=$1", [p.profile_id]);
    case "meeting.transcript.ready":
    case "meeting.actions.extracted":
      return first("SELECT owner_user_id AS u FROM meetings WHERE id=$1", [p.meeting_id]);
    case "match.created":
      return first("SELECT user_id AS u FROM profiles WHERE id=$1", [p.subject_id]);
    case "integration.sync.failed":
      return first("SELECT a.user_id AS u FROM sync_jobs j JOIN integration_accounts a ON a.id=j.integration_account_id WHERE j.id=$1", [p.job_id]);
    default:
      return null; // privacy.deletion.requested etc. are never forwarded
  }
}

/** Outbox consumer: fan out one event to the owner's subscribed endpoints (idempotent per endpoint+event). */
export async function enqueueWebhookDeliveries(c: pg.PoolClient, ev: { id: string; event_type: string; payload: any }) {
  if (ev.event_type === "privacy.deletion.requested") return 0;
  const has = await c.query("SELECT 1 FROM webhook_endpoints WHERE active AND $1 = ANY(events) LIMIT 1", [ev.event_type]);
  if (!has.rowCount) return 0;
  const owner = await eventOwner(c, ev.event_type, ev.payload);
  if (!owner) return 0;
  const r = await c.query(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, payload)
     SELECT id, $2, $3, $4 FROM webhook_endpoints WHERE owner_user_id=$1 AND active AND $3 = ANY(events)
     ON CONFLICT (endpoint_id, outbox_event_id) WHERE outbox_event_id IS NOT NULL DO NOTHING`,
    [owner, ev.id, ev.event_type, JSON.stringify(ev.payload)], // catalog payloads carry ids only (no PII); redact() would mangle uuids
  );
  return r.rowCount ?? 0;
}

async function resolvesPrivate(host: string): Promise<boolean> {
  if (allowPrivate()) return false;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    return false; // DNS failure surfaces as a network error on fetch
  }
}

/** Worker: deliver due webhooks. Leases rows (next_attempt_at += 5 min) so concurrent workers don't double-send. */
export async function processWebhookDeliveries(limit = 50, onlyId?: string): Promise<number> {
  const due = await q<any>(
    `UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '5 minutes' FROM webhook_endpoints e
     WHERE d.id IN (SELECT id FROM webhook_deliveries WHERE status IN ('queued','retry') AND next_attempt_at <= now() ${onlyId ? "AND id=$2" : ""} ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       AND e.id = d.endpoint_id
     RETURNING d.id, d.event_type, d.payload, d.attempt_count, d.created_at, d.outbox_event_id, e.id AS endpoint_id, e.url, e.secret_sealed, e.active`,
    onlyId ? [limit, onlyId] : [limit],
  );
  let delivered = 0;
  for (const d of due) {
    const attempt = d.attempt_count + 1;
    if (!d.active) {
      await q("UPDATE webhook_deliveries SET status='dead', last_error='endpoint_disabled', attempt_count=$2 WHERE id=$1", [d.id, attempt]);
      continue;
    }
    const body = JSON.stringify({ id: d.outbox_event_id ?? d.id, delivery_id: d.id, type: d.event_type, created_at: new Date(d.created_at).toISOString(), data: d.payload });
    const ts = Math.floor(Date.now() / 1000);
    const secret = unseal<{ s: string }>(d.secret_sealed).s;
    let status: number | null = null;
    let err: string | null = null;
    try {
      const host = new URL(d.url).hostname;
      if (await resolvesPrivate(host)) throw new Error("private_address");
      const res = await fetch(d.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000)),
        headers: {
          "content-type": "application/json",
          "user-agent": "LINKOS-Webhooks/1.0",
          "linkos-event": d.event_type,
          "linkos-delivery": d.id,
          "linkos-signature": `t=${ts},v1=${signPayload(secret, ts, body)}`,
        },
        body,
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
      if (status < 200 || status >= 300) err = `http_${status}`;
    } catch (e) {
      err = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.slice(0, 200);
      if (err === "private_address") status = 0;
    }
    if (!err) {
      delivered++;
      await q("UPDATE webhook_deliveries SET status='delivered', attempt_count=$2, response_status=$3, delivered_at=now(), last_error=NULL WHERE id=$1", [d.id, attempt, status]);
      await q("UPDATE webhook_endpoints SET consecutive_failures=0 WHERE id=$1", [d.endpoint_id]);
      continue;
    }
    const retry = status !== 0 && isRetryableStatus(status) && attempt < WEBHOOK_MAX_ATTEMPTS && d.event_type !== "webhook.test";
    await q("UPDATE webhook_deliveries SET status=$2, attempt_count=$3, response_status=$4, last_error=$5, next_attempt_at = now() + ($6 || ' seconds')::interval WHERE id=$1", [
      d.id,
      retry ? "retry" : "dead",
      attempt,
      status,
      err,
      String(webhookRetryDelaySec(attempt)),
    ]);
    const ep = await one<{ consecutive_failures: number }>("UPDATE webhook_endpoints SET consecutive_failures=consecutive_failures+1 WHERE id=$1 RETURNING consecutive_failures", [d.endpoint_id]);
    if ((ep?.consecutive_failures ?? 0) >= AUTO_DISABLE_AFTER) await q("UPDATE webhook_endpoints SET active=false, disabled_reason='too_many_failures' WHERE id=$1", [d.endpoint_id]);
    log("warn", "webhook.delivery_failed", { delivery: d.id, attempt, status, err });
  }
  return delivered;
}
