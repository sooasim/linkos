// Outbox relay + background jobs. Run: `pnpm worker` (separate process in production).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, q, tx } from "./lib/db";
import { log } from "./lib/platform";
import { processSyncJobs } from "./modules/integration";
import { processDeletions } from "./modules/security";

/** Publish outbox events (at-least-once). Consumers must be idempotent. */
export async function relayOutbox(batch = 100): Promise<number> {
  return tx(async (c) => {
    const rows = await c.query<{ id: string; event_type: string; aggregate_id: string; payload: any }>(
      "SELECT id, event_type, aggregate_id, payload FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED",
      [batch],
    );
    for (const ev of rows.rows) {
      try {
        await dispatch(c, ev.event_type, ev.payload);
        await c.query("UPDATE outbox_events SET published_at=now() WHERE id=$1", [ev.id]);
      } catch (e) {
        await c.query("UPDATE outbox_events SET attempts=attempts+1, last_error=$2 WHERE id=$1", [ev.id, (e as Error).message.slice(0, 300)]);
      }
    }
    return rows.rowCount ?? 0;
  });
}

async function dispatch(c: import("pg").PoolClient, type: string, payload: any) {
  switch (type) {
    case "contact.updated": {
      // integration-service: if the owner has an active Google account, enqueue a versioned idempotent sync job
      await c.query(
        `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key)
         SELECT a.id, 'google.contact.upsert', jsonb_build_object('contactId', ct.id), 'contact:' || ct.id || ':v' || ct.version
         FROM contacts ct JOIN integration_accounts a ON a.user_id = ct.owner_user_id AND a.provider='google' AND a.status='active'
         WHERE ct.id = $1
         ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING`,
        [payload.contact_id],
      );
      break;
    }
    case "exchange.completed":
      // relationship strength nudge for the sender's side (growth/analytics consumers read the event table)
      await c.query("UPDATE relationships SET strength = LEAST(1, COALESCE(strength,0) + 0.1) WHERE id = ANY($1::uuid[])", [payload.relationship_ids]);
      break;
    default:
      break; // analytics/notification consumers read from outbox_events directly
  }
}

async function expireSessions() {
  await q(
    `UPDATE exchange_sessions SET state='EXPIRED', short_code=NULL, updated_at=now()
     WHERE expires_at < now() AND state IN ('CREATED','DISCOVERING','CHANNEL_SELECTED','OFFERED','RECEIVER_OPENED','CONSENT_PENDING','CHANNEL_FAILED')`,
  );
  await q("DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day'");
  await q("DELETE FROM idempotency_keys WHERE created_at < now() - interval '2 days'");
}

export async function tick() {
  const n = await relayOutbox();
  const s = await processSyncJobs();
  const d = await processDeletions();
  await expireSessions();
  return { relayed: n, synced: s, deleted: d };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  (async () => {
    log("info", "worker.started");
    while (!stopping) {
      try {
        const r = await tick();
        if (r.relayed || r.synced || r.deleted) log("info", "worker.tick", r);
      } catch (e) {
        log("error", "worker.tick_failed", { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, Number(process.env.WORKER_INTERVAL_MS ?? 2000)));
    }
    await closePool();
  })();
}
