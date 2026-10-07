// analytics module — 백서 23 핵심 KPI (Exchange Success / Reciprocal / Claim / OCR Correction / Follow-up Completion)
import { one, q } from "../lib/db";

export async function myHome(userId: string) {
  const [counts, recent, followups, meetings, sessions] = await Promise.all([
    one<any>(
      `SELECT
         (SELECT count(*)::int FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND merged_into_id IS NULL) AS contacts,
         (SELECT count(*)::int FROM encounters WHERE owner_user_id=$1 AND occurred_at > now() - interval '7 days') AS encounters_7d,
         (SELECT count(*)::int FROM followups WHERE owner_user_id=$1 AND status='open') AS open_followups,
         (SELECT count(*)::int FROM exchange_sessions WHERE sender_user_id=$1 AND state IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED')) AS exchanges`,
      [userId],
    ),
    q<any>(
      `SELECT c.id, c.full_name, co.name AS company, c.job_title, e.occurred_at, e.source, e.place_label
       FROM encounters e JOIN contacts c ON c.id=e.contact_id LEFT JOIN companies co ON co.id=c.company_id
       WHERE e.owner_user_id=$1 AND c.deleted_at IS NULL ORDER BY e.occurred_at DESC LIMIT 6`,
      [userId],
    ),
    q<any>(
      `SELECT f.id, f.title, f.due_at, f.kind, f.source, f.contact_id, c.full_name FROM followups f LEFT JOIN contacts c ON c.id=f.contact_id
       WHERE f.owner_user_id=$1 AND f.status='open' ORDER BY f.due_at NULLS LAST LIMIT 5`,
      [userId],
    ),
    q<any>(
      `SELECT id, title, started_at, next_meeting_at FROM meetings WHERE owner_user_id=$1 AND (started_at > now() - interval '1 day' OR next_meeting_at > now()) ORDER BY COALESCE(next_meeting_at, started_at) LIMIT 3`,
      [userId],
    ),
    q<any>(`SELECT id, state, created_at FROM exchange_sessions WHERE sender_user_id=$1 ORDER BY created_at DESC LIMIT 5`, [userId]),
  ]);
  return { counts, recent, followups, meetings, sessions };
}

/** Funnel from the outbox event stream for a sender (or globally for admins when userId is null). */
export async function exchangeKpis(userId: string | null, days = 30) {
  const scope = userId ? "AND s.sender_user_id = $2" : "";
  const params: unknown[] = [days];
  if (userId) params.push(userId);
  const r = await one<any>(
    `SELECT count(*)::int AS created,
       count(*) FILTER (WHERE s.receiver_opened_at IS NOT NULL)::int AS opened,
       count(*) FILTER (WHERE s.state IN ('EXCHANGED','CLAIM_PENDING','CLAIMED','SYNCED') OR s.use_count > 0)::int AS reciprocated,
       count(*) FILTER (WHERE s.state IN ('CLAIMED','SYNCED'))::int AS claimed
     FROM exchange_sessions s WHERE s.created_at > now() - ($1 || ' days')::interval ${scope}`,
    params,
  );
  const ch = await q<any>(
    `SELECT a.channel, count(*)::int AS attempts, count(*) FILTER (WHERE a.outcome='success')::int AS success
     FROM exchange_attempts a JOIN exchange_sessions s ON s.id=a.exchange_session_id
     WHERE a.created_at > now() - ($1 || ' days')::interval ${scope} GROUP BY a.channel ORDER BY attempts DESC`,
    params,
  );
  const ocr = await one<any>(
    `SELECT count(*)::int AS cards,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_each(c.field_provenance) kv WHERE kv.value->>'source' = 'user'))::int AS corrected
     FROM contacts c WHERE c.source IN ('scan','exchange') AND c.created_at > now() - ($1 || ' days')::interval ${userId ? "AND c.owner_user_id=$2" : ""}`,
    params,
  );
  const fu = await one<any>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='done')::int AS done FROM followups f WHERE f.created_at > now() - ($1 || ' days')::interval ${userId ? "AND f.owner_user_id=$2" : ""}`,
    params,
  );
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    windowDays: days,
    funnel: r,
    exchangeSuccessRate: pct(r.opened, r.created),
    reciprocalRate: pct(r.reciprocated, r.opened),
    claimRate: pct(r.claimed, r.reciprocated),
    ocrCorrectionRate: pct(ocr.corrected, ocr.cards),
    followupCompletion: pct(fu.done, fu.total),
    channels: ch,
  };
}
