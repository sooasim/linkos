// security module — 개인정보 export/delete, 감사로그 조회 (Privacy, Security & Compliance)
import { allowEncounterRewrite, one, pool, q, tx } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit, log, rateLimit } from "../lib/platform";
import { signedFileUrl, storeGeneratedObject } from "./files";
import { departAllOrgs } from "./org";

export const DELETION_GRACE_DAYS = 7;

/**
 * Portable JSON of everything the user owns (synchronous build). The API serves it as a queued job
 * (requestPrivacyExport → worker → signed download); this direct form stays for internal callers/tests.
 */
export async function exportMyData(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const data = await buildPortableExport(ctx.userId);
  await audit(pool(), ctx, "privacy.export", "user", ctx.userId);
  return data;
}

async function buildPortableExport(u: string) {
  const [user, profiles, fields, offers, needs, contacts, encounters, notes, meetings, actions, followups, consents, exchanges] = await Promise.all([
    one("SELECT id, email, display_name, locale, created_at FROM users WHERE id=$1", [u]),
    q("SELECT * FROM profiles WHERE user_id=$1", [u]),
    q("SELECT pf.* FROM profile_fields pf JOIN profiles p ON p.id=pf.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT o.id, o.profile_id, o.text, o.provenance FROM offers o JOIN profiles p ON p.id=o.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT n.id, n.profile_id, n.text, n.provenance FROM needs n JOIN profiles p ON p.id=n.profile_id WHERE p.user_id=$1", [u]),
    q("SELECT c.*, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.owner_user_id=$1", [u]),
    q("SELECT * FROM encounters WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM notes WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM meetings WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM action_items WHERE owner_user_id=$1", [u]),
    q("SELECT * FROM followups WHERE owner_user_id=$1", [u]),
    q("SELECT consent_type, policy_version, granted, created_at FROM consent_records WHERE subject_user_id=$1 ORDER BY created_at", [u]),
    q("SELECT id, state, selected_channel, created_at, expires_at FROM exchange_sessions WHERE sender_user_id=$1", [u]),
  ]);
  // Track B data (communication, scheduling, integrations) — secrets/tokens are never exported
  const [messages, templates, sequences, calendarCandidates, bookingPages, webhookEndpoints, fieldMappings] = await Promise.all([
    q("SELECT id, contact_id, channel, to_address, subject, body, language, provenance, status, provider, sent_at, created_at FROM messages WHERE owner_user_id=$1", [u]),
    q("SELECT id, scope, name, channel, language, subject, body, created_at FROM message_templates WHERE owner_user_id=$1", [u]),
    q("SELECT id, contact_id, name, status, created_at FROM followup_sequences WHERE owner_user_id=$1", [u]),
    q("SELECT id, source, title, starts_at, ends_at, status, provenance, attendees, requester_name, requester_email, created_at FROM calendar_candidates WHERE owner_user_id=$1", [u]),
    q("SELECT id, title, duration_min, timezone, windows, active, created_at FROM booking_pages WHERE owner_user_id=$1", [u]),
    q("SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE owner_user_id=$1", [u]),
    q("SELECT provider, object_type, mapping, updated_at FROM crm_field_mappings WHERE owner_user_id=$1", [u]),
  ]);
  return { exportedAt: new Date().toISOString(), format: "linkos-portable-v1", user, profiles, profileFields: fields, offers, needs, contacts, encounters, notes, meetings, actionItems: actions, followups, consents, exchangeSessions: exchanges, messages, templates, sequences, calendarCandidates, bookingPages, webhookEndpoints, fieldMappings };
}

// ---------- exportMyData as a queued job (04_OPENAPI: POST /me/privacy/export → 202 Queued) ----------
export const PRIVACY_EXPORT_KIND = "privacy:portable";
/** download window of a finished export (job + encrypted object) */
export const PRIVACY_EXPORT_TTL_DAYS = 7;
const PRIVACY_EXPORT_MAX_ATTEMPTS = 3;

interface PrivacyExportRow {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  object_id: string | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date;
}

function privacyExportView(j: PrivacyExportRow) {
  const expired = j.expires_at.getTime() < Date.now();
  return {
    id: j.id,
    status: expired && j.status === "done" ? ("expired" as const) : j.status,
    createdAt: j.created_at,
    completedAt: j.completed_at,
    expiresAt: j.expires_at,
    statusUrl: `/api/v1/me/privacy/export/${j.id}`,
    // short-lived signed link (5 min) to the encrypted JSON — fetched again from statusUrl when it lapses
    downloadUrl: j.status === "done" && j.object_id && !expired ? `${signedFileUrl(j.object_id)}&download=1` : null,
    error: j.status === "failed" ? "export_failed" : null,
  };
}

/** POST /me/privacy/export — queue a portable export of my data; the worker builds it (processPrivacyExports). */
export async function requestPrivacyExport(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  await rateLimit(`privacy:export:${ctx.userId}`, 10, 3600);
  const j = await one<PrivacyExportRow>(
    `INSERT INTO export_jobs (user_id, kind, format, status, expires_at) VALUES ($1,$2,'json','queued', now() + ($3 || ' days')::interval)
     RETURNING id, status, object_id, error, created_at, completed_at, expires_at`,
    [ctx.userId, PRIVACY_EXPORT_KIND, String(PRIVACY_EXPORT_TTL_DAYS)],
  );
  await audit(pool(), ctx, "privacy.export_requested", "export_job", j!.id);
  return privacyExportView(j!);
}

/** GET /me/privacy/export/{id} — job status and, once done, a signed download link. Only the requester sees it. */
export async function getPrivacyExport(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const j = await one<PrivacyExportRow>(
    "SELECT id, status, object_id, error, created_at, completed_at, expires_at FROM export_jobs WHERE id=$1 AND user_id=$2 AND kind=$3",
    [id, ctx.userId, PRIVACY_EXPORT_KIND],
  );
  if (!j) throw notFound("export");
  return privacyExportView(j);
}

/** Build one claimed job: JSON → encrypted object store → job done. Returns the data (legacy inline callers). */
async function runPrivacyExportJob(job: { id: string; user_id: string }) {
  try {
    const data = await buildPortableExport(job.user_id);
    const obj = await storeGeneratedObject({
      ownerUserId: job.user_id,
      purpose: "privacy_export",
      bytes: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      contentType: "application/json",
      filename: "linkos-my-data.json",
      retentionDays: PRIVACY_EXPORT_TTL_DAYS,
    });
    await tx(async (c) => {
      await c.query("UPDATE export_jobs SET status='done', object_id=$2, completed_at=now(), error=NULL WHERE id=$1", [job.id, obj.id]);
      await audit(c, { userId: job.user_id }, "privacy.export", "user", job.user_id, { job: job.id });
    });
    return data;
  } catch (e) {
    await q(
      "UPDATE export_jobs SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END, error=$2 WHERE id=$1",
      [job.id, (e as Error).message.slice(0, 300), PRIVACY_EXPORT_MAX_ATTEMPTS],
    );
    log("warn", "privacy.export_failed", { job: job.id, error: (e as Error).message });
    return null;
  }
}

async function claimPrivacyExports(limit: number, onlyId?: string) {
  // a job left 'processing' by a crashed worker is picked up again after 15 minutes
  return q<{ id: string; user_id: string }>(
    `UPDATE export_jobs SET status='processing', attempts=attempts+1 WHERE id IN (
       SELECT id FROM export_jobs WHERE kind=$1 AND ($3::uuid IS NULL OR id=$3)
         AND (status='queued' OR (status='processing' AND created_at < now() - interval '15 minutes' AND attempts < $4))
       ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, user_id`,
    [PRIVACY_EXPORT_KIND, limit, onlyId ?? null, PRIVACY_EXPORT_MAX_ATTEMPTS],
  );
}

/** Worker: build queued privacy exports. */
export async function processPrivacyExports(limit = 5): Promise<number> {
  const jobs = await claimPrivacyExports(limit);
  for (const j of jobs) await runPrivacyExportJob(j);
  return jobs.length;
}

/**
 * Transitional (deprecated): the pre-job UI expects `{ data }` in the POST response. The job is still created and
 * recorded exactly like a queued one, then processed right away so the response can carry the same data inline.
 * Clients that send `Prefer: respond-async` (or `{ "async": true }`) get the plain queued job.
 */
export async function requestPrivacyExportInline(ctx: Ctx) {
  const job = await requestPrivacyExport(ctx);
  const [claimed] = await claimPrivacyExports(1, job.id);
  const data = claimed ? await runPrivacyExportJob(claimed) : null;
  return { ...(await getPrivacyExport(ctx, job.id)), data };
}

/** POST /me/privacy/delete — revoke sessions now, deactivate, hard-delete after the grace period (worker). */
export async function requestDeletion(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const u = ctx.userId;
  const deadline = new Date(Date.now() + DELETION_GRACE_DAYS * 864e5);
  return tx(async (c) => {
    const r = await one<{ id: string }>("INSERT INTO deletion_requests (user_id, deadline) VALUES ($1,$2) RETURNING id", [u, deadline], c);
    await c.query("UPDATE users SET status='pending_deletion', updated_at=now() WHERE id=$1", [u]);
    await c.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [u]);
    // stop outward-facing surfaces immediately: public booking links, outgoing webhooks, push devices
    await c.query("UPDATE booking_pages SET active=false WHERE owner_user_id=$1", [u]);
    await c.query("UPDATE webhook_endpoints SET active=false, disabled_reason='account_deletion' WHERE owner_user_id=$1", [u]);
    await c.query("DELETE FROM push_subscriptions WHERE user_id=$1", [u]);
    await c.query("UPDATE exchange_sessions SET state='REVOKED', revoked_at=now(), short_code=NULL WHERE sender_user_id=$1 AND state NOT IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED','REVOKED','EXPIRED','CANCELLED')", [u]);
    await emit(c, "privacy.deletion.requested", "user", u, { subject_id: u, deadline: deadline.toISOString() });
    await audit(c, ctx, "privacy.delete_requested", "user", u, { deadline: deadline.toISOString() });
    return { id: r!.id, status: "scheduled", deadline: deadline.toISOString() };
  });
}

/** Worker: hard delete users whose grace period ended. Cascades remove owned data (ON DELETE CASCADE). */
export async function processDeletions(): Promise<number> {
  const due = await q<{ id: string; user_id: string }>("SELECT id, user_id FROM deletion_requests WHERE status='scheduled' AND deadline <= now() LIMIT 20");
  for (const d of due) {
    await tx(async (c) => {
      // F-132: company-owned leads are reassigned inside each org before the account (and its personal data) is removed
      await departAllOrgs(c, d.user_id);
      // §9: privacy deletion is one of the two paths allowed to remove (append-only) Encounters
      await allowEncounterRewrite(c, "delete");
      await c.query("UPDATE contacts SET linked_user_id=NULL WHERE linked_user_id=$1", [d.user_id]);
      await c.query("DELETE FROM users WHERE id=$1", [d.user_id]);
      await c.query("UPDATE deletion_requests SET status='completed', completed_at=now() WHERE id=$1", [d.id]);
      await audit(c, { userId: null }, "privacy.deleted", "user", d.user_id);
    });
  }
  return due.length;
}

/**
 * F-137 / F-166 "내 활동 기록": my own audit trail, newest first, keyset-paged by id (`before` = last id of the previous page).
 * Only an allow-list of non-sensitive metadata keys is returned (audit() already runs redact()); audit_logs stores no IP/device.
 */
export async function myAuditLog(userId: string, opts: { before?: string | null; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const before = opts.before && /^\d{1,18}$/.test(opts.before) ? opts.before : null;
  const rows = await q<{ id: string; action: string; entity_type: string | null; organization_id: string | null; metadata: Record<string, unknown> | null; created_at: Date }>(
    `SELECT id::text AS id, action, entity_type, organization_id, metadata, created_at FROM audit_logs
     WHERE actor_user_id=$1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
    [userId, before, limit + 1],
  );
  const page = rows.slice(0, limit).map((r) => ({ ...r, metadata: pickAuditMeta(r.metadata) }));
  return { entries: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

const AUDIT_META_KEYS = ["format", "report", "period", "rows", "provider", "queued", "count", "role", "strategy", "type"] as const;
function pickAuditMeta(m: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of AUDIT_META_KEYS) {
    const v = m?.[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
