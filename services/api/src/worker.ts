// Outbox relay + background jobs. Run: `pnpm worker` (separate process in production).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, q, tx } from "./lib/db";
import { emit, log } from "./lib/platform";
import { sendMail } from "./lib/mail";
import { processSyncJobs } from "./modules/integration";
import { fanOutLivingUpdate } from "./modules/living";
import { processDeletions } from "./modules/security";
import { processRetention } from "./modules/enterprise";
import { processReferralRewards } from "./modules/referral";
import { processStrengths } from "./modules/network";
import { purgeExpiredObjects } from "./modules/files";
import { processTranscriptions } from "./modules/recording";
import { notify, processPushQueue } from "./modules/push";
import { enqueueWebhookDeliveries, processWebhookDeliveries } from "./modules/webhooks";

/** Publish outbox events (at-least-once). Consumers must be idempotent. */
export async function relayOutbox(batch = 100): Promise<number> {
  return tx(async (c) => {
    const rows = await c.query<{ id: string; event_type: string; aggregate_id: string; payload: any }>(
      "SELECT id, event_type, aggregate_id, payload FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED",
      [batch],
    );
    for (const ev of rows.rows) {
      try {
        await c.query("SAVEPOINT ev");
        await dispatch(c, ev.event_type, ev.payload);
        await enqueueWebhookDeliveries(c, ev); // F-123: fan out to the owner's subscribed webhooks
        await c.query("RELEASE SAVEPOINT ev");
        await c.query("UPDATE outbox_events SET published_at=now() WHERE id=$1", [ev.id]);
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT ev");
        await c.query("UPDATE outbox_events SET attempts=attempts+1, last_error=$2 WHERE id=$1", [ev.id, (e as Error).message.slice(0, 300)]);
      }
    }
    return rows.rowCount ?? 0;
  });
}

async function dispatch(c: import("pg").PoolClient, type: string, payload: any) {
  // NOTE: every query here must use the relay transaction client `c`
  switch (type) {
    case "contact.updated": {
      // integration-service: if the owner has an active Google account, enqueue a versioned idempotent sync job
      await c.query(
        `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key)
         SELECT a.id, 'google.contact.upsert', jsonb_build_object('contactId', ct.id), 'contact:' || ct.id || ':v' || ct.version
         FROM contacts ct JOIN integration_accounts a ON a.user_id = ct.owner_user_id AND a.provider='google' AND a.status='active'
           AND 'https://www.googleapis.com/auth/contacts' = ANY(a.scopes)
         WHERE ct.id = $1
         ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING`,
        [payload.contact_id],
      );
      // CRM accounts: only records already pushed (mapped) follow local edits; etag/If-Match guards stop silent overwrites
      await c.query(
        `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider)
         SELECT a.id, 'crm.' || em.entity_type || '.upsert', jsonb_build_object('contactId', ct.id), em.entity_type || ':' || ct.id || ':v' || ct.version, a.provider
         FROM contacts ct JOIN external_mappings em ON em.local_id = ct.id AND em.entity_type IN ('contact','lead')
         JOIN integration_accounts a ON a.id = em.integration_account_id AND a.user_id = ct.owner_user_id AND a.status='active' AND a.provider <> 'google'
         WHERE ct.id = $1
         ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING`,
        [payload.contact_id],
      );
      break;
    }
    case "followup.due": {
      // F-110: Web Push to the owner's devices (delivered by processPushQueue)
      const f = await c.query<{ title: string; contact_id: string | null }>("SELECT title, contact_id FROM followups WHERE id=$1", [payload.followup_id]);
      if (f.rows[0]) await notify(c, payload.user_id, { kind: "followup.due", title: "후속 할 일", body: f.rows[0].title, url: f.rows[0].contact_id ? `/app/people/${f.rows[0].contact_id}` : "/app", dedupeKey: `followup:${payload.followup_id}` });
      break;
    }
    case "exchange.completed":
      // relationship strength nudge for the sender's side (growth/analytics consumers read the event table)
      await c.query("UPDATE relationships SET strength = LEAST(1, COALESCE(strength,0) + 0.1) WHERE id = ANY($1::uuid[])", [payload.relationship_ids]);
      break;
    case "profile.updated":
      // notification consumer — F-033 Living Update suggestions for everyone holding this person's card
      await c.query("SAVEPOINT living_update");
      try {
        await fanOutLivingUpdate(c, payload.profile_id);
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT living_update");
        throw e;
      }
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

/** F-109 리마인더: due follow-ups → followup.due event (+ email when SMTP is configured). Never sends to the contact. */
export async function processReminders(limit = 100): Promise<number> {
  const due = await q<{ id: string; owner_user_id: string; title: string; email: string | null; full_name: string | null }>(
    `SELECT f.id, f.owner_user_id, f.title, u.email, c.full_name FROM followups f JOIN users u ON u.id=f.owner_user_id LEFT JOIN contacts c ON c.id=f.contact_id
     WHERE f.status='open' AND f.reminded_at IS NULL AND f.due_at <= now() AND u.status='active' ORDER BY f.due_at LIMIT $1`,
    [limit],
  );
  for (const f of due) {
    await tx(async (c) => {
      const upd = await c.query("UPDATE followups SET reminded_at=now() WHERE id=$1 AND reminded_at IS NULL", [f.id]);
      if (!upd.rowCount) return;
      await emit(c, "followup.due", "followup", f.id, { followup_id: f.id, user_id: f.owner_user_id });
    });
    if (f.email) await sendMail(f.email, `[LINKOS] 후속 할 일: ${f.title}`, `오늘 처리할 후속 할 일이 있어요.\n\n- ${f.title}${f.full_name ? ` (${f.full_name})` : ""}\n\n앱에서 확인하세요.`).catch(() => false);
  }
  return due.length;
}

export async function tick() {
  const n = await relayOutbox();
  await processReminders();
  const s = await processSyncJobs();
  const p = await processPushQueue();
  const w = await processWebhookDeliveries();
  const d = await processDeletions();
  // F-082/F-083 transcription of uploaded recording parts, F-019 retention purge of stored originals
  const t = await processTranscriptions().catch((e) => (log("warn", "worker.stt_failed", { error: (e as Error).message }), 0));
  const purged = await purgeExpiredObjects().catch(() => 0);
  await expireSessions();
  const retained = await processRetention(); // F-136
  const strengths = await processStrengths(); // F-074
  const rewards = await processReferralRewards(); // F-197 (no-op unless REFERRAL_REWARDS_ENABLED=1)
  await q("DELETE FROM webauthn_challenges WHERE expires_at < now() - interval '1 day'");
  await q("DELETE FROM sso_login_states WHERE expires_at < now() - interval '1 day'");
  return { relayed: n, synced: s, deleted: d, transcribed: t, purged, retained, strengths, rewards, pushed: p, webhooks: w };
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
        if (r.relayed || r.synced || r.deleted || r.transcribed || r.purged || r.pushed || r.webhooks) log("info", "worker.tick", r);
      } catch (e) {
        log("error", "worker.tick_failed", { error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, Number(process.env.WORKER_INTERVAL_MS ?? 2000)));
    }
    await closePool();
  })();
}
