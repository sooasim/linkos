// analytics module — 백서 23 핵심 KPI (Exchange Success / Reciprocal / Claim / OCR Correction / Follow-up Completion /
// Match-to-Meeting / Retention / Enterprise Active Relationships) + §20 RUM (F-188)
import { GUEST_LANDING_LCP_TARGET_MS, GUEST_LANDING_ROUTE, kpiRate, matchToMeeting, parseVitalSample, retentionStep } from "@linkos/domain";
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
  // §23 KPIs added to the same shape (user scope = the viewer; null = platform-wide)
  const orgIds = userId ? (await q<{ organization_id: string }>("SELECT organization_id FROM organization_members WHERE user_id=$1 AND status='active'", [userId])).map((o) => o.organization_id) : null;
  const [retention, m2m, ear, rum] = await Promise.all([
    retentionKpi(userId, days),
    matchToMeetingKpi(userId, days),
    orgIds && !orgIds.length ? Promise.resolve(null) : enterpriseActiveRelationships(orgIds, days),
    webVitalsKpi(days, GUEST_LANDING_ROUTE),
  ]);
  return {
    retention,
    retentionRate: retention.retentionRate,
    matchToMeeting: m2m,
    matchToMeetingRate: m2m.matchToMeetingRate,
    enterpriseActiveRelationships: ear,
    guestLandingLcpP75Ms: rum.guestLandingLcpP75Ms,
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

// ---------- 백서 §23 KPIs (F-188): Retention · Match-to-Meeting · Enterprise Active Relationships · §20 RUM ----------
// Relationship actions from existing tables (no new tracking): exchange, encounter, contact created, note, meeting,
// follow-up done, message sent. $1 = window days, $2 = optional user scope.
const ACTIONS_SQL = (scoped: boolean) => `
  WITH acts AS (
    SELECT sender_user_id AS uid, created_at AS at FROM exchange_sessions WHERE created_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, occurred_at FROM encounters WHERE occurred_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, created_at FROM contacts WHERE created_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, created_at FROM notes WHERE created_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, created_at FROM meetings WHERE created_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, completed_at FROM followups WHERE status = 'done' AND completed_at > now() - make_interval(days => $1 * 2)
    UNION ALL SELECT owner_user_id, sent_at FROM messages WHERE sent_at > now() - make_interval(days => $1 * 2)
  ),
  per AS (
    SELECT uid,
      bool_or(at <= now() - make_interval(days => $1)) AS prev,
      bool_or(at > now() - make_interval(days => $1)) AS cur
    FROM acts WHERE uid IS NOT NULL ${scoped ? "AND uid = $2" : ""} GROUP BY uid
  )
  SELECT count(*) FILTER (WHERE prev)::int AS previous_active,
         count(*) FILTER (WHERE prev AND cur)::int AS retained,
         count(*) FILTER (WHERE cur)::int AS current_active
  FROM per`;

/** Retention (월간 관계 행동 재사용): of users active in the previous window, the share active again in this one. */
export async function retentionKpi(userId: string | null, days = 30) {
  const r = await one<{ previous_active: number; retained: number; current_active: number }>(ACTIONS_SQL(!!userId), userId ? [days, userId] : [days]);
  return { windowDays: days, ...retentionStep({ previousActive: r?.previous_active ?? 0, retained: r?.retained ?? 0, currentActive: r?.current_active ?? 0 }) };
}

/**
 * Match-to-Meeting (매칭→미팅 예약): AI matches first announced in the window whose subject later created a meeting
 * with the candidate (a contact linked to the candidate's account) or booked one through an introduction.
 */
export async function matchToMeetingKpi(userId: string | null, days = 30) {
  const r = await one<{ matches: number; converted: number }>(
    `WITH m AS (
       SELECT ma.first_seen_at, sp.user_id AS subject_uid, cp.user_id AS cand_uid
       FROM match_announcements ma
       JOIN profiles sp ON sp.id = ma.subject_profile_id JOIN profiles cp ON cp.id = ma.candidate_profile_id
       WHERE ma.first_seen_at > now() - make_interval(days => $1) ${userId ? "AND sp.user_id = $2" : ""}
     )
     SELECT count(*)::int AS matches,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM meetings mt JOIN meeting_participants mp ON mp.meeting_id = mt.id JOIN contacts c ON c.id = mp.contact_id
         WHERE mt.owner_user_id = m.subject_uid AND c.owner_user_id = m.subject_uid AND c.linked_user_id = m.cand_uid
           AND mt.created_at >= m.first_seen_at
       ) OR EXISTS (
         SELECT 1 FROM introductions i JOIN contacts a ON a.id = i.party_a_contact_id JOIN contacts b ON b.id = i.party_b_contact_id
         WHERE i.meeting_at IS NOT NULL AND i.created_at >= m.first_seen_at
           AND ((a.linked_user_id = m.subject_uid AND b.linked_user_id = m.cand_uid) OR (a.linked_user_id = m.cand_uid AND b.linked_user_id = m.subject_uid))
       ))::int AS converted
     FROM m`,
    userId ? [days, userId] : [days],
  );
  return { windowDays: days, ...matchToMeeting(r?.matches ?? 0, r?.converted ?? 0) };
}

/**
 * Enterprise Active Relationships (팀 관계 엔터티 활동량): org-scope contacts with activity in the window — updated,
 * met (encounter), noted or in a meeting. `orgIds` null = all organizations (platform admin view).
 */
export async function enterpriseActiveRelationships(orgIds: string[] | null, days = 30) {
  if (orgIds && !orgIds.length) return { windowDays: days, organizations: 0, orgRelationships: 0, activeRelationships: 0, activeRate: null as number | null };
  const r = await one<{ orgs: number; total: number; active: number }>(
    `SELECT count(DISTINCT c.organization_id)::int AS orgs, count(*)::int AS total,
       count(*) FILTER (WHERE c.updated_at > now() - make_interval(days => $1)
         OR EXISTS (SELECT 1 FROM encounters e WHERE e.contact_id = c.id AND e.occurred_at > now() - make_interval(days => $1))
         OR EXISTS (SELECT 1 FROM notes n WHERE n.contact_id = c.id AND n.created_at > now() - make_interval(days => $1))
         OR EXISTS (SELECT 1 FROM meeting_participants mp JOIN meetings mt ON mt.id = mp.meeting_id WHERE mp.contact_id = c.id AND mt.created_at > now() - make_interval(days => $1))
       )::int AS active
     FROM contacts c
     WHERE c.scope = 'org' AND c.organization_id IS NOT NULL AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
       ${orgIds ? "AND c.organization_id = ANY($2::uuid[])" : ""}`,
    orgIds ? [days, orgIds] : [days],
  );
  return { windowDays: days, organizations: r?.orgs ?? 0, orgRelationships: r?.total ?? 0, activeRelationships: r?.active ?? 0, activeRate: kpiRate(r?.active ?? 0, r?.total ?? 0) };
}

/** §20 RUM: p75 of real-user web vitals per route (guest landing LCP target p75 < 2.5s). */
export async function webVitalsKpi(days = 30, route?: string) {
  const rows = await q<{ route: string; metric: string; n: number; p75: number | null; good: number }>(
    `SELECT route, metric, count(*)::int AS n, percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75,
            count(*) FILTER (WHERE rating = 'good')::int AS good
     FROM web_vitals_samples WHERE created_at > now() - make_interval(days => $1) ${route ? "AND route = $2" : ""}
     GROUP BY route, metric ORDER BY route, metric`,
    route ? [days, route] : [days],
  );
  const metrics = rows.map((r) => ({ route: r.route, metric: r.metric, samples: r.n, p75: r.p75 == null ? null : Math.round(Number(r.p75) * 1000) / 1000, goodRate: kpiRate(r.good, r.n) }));
  const lcp = metrics.find((m) => m.route === GUEST_LANDING_ROUTE && m.metric === "LCP");
  return {
    windowDays: days,
    guestLandingLcpP75Ms: lcp?.p75 ?? null,
    guestLandingLcpTargetMs: GUEST_LANDING_LCP_TARGET_MS,
    guestLandingLcpWithinTarget: lcp?.p75 == null ? null : lcp.p75 < GUEST_LANDING_LCP_TARGET_MS,
    metrics,
  };
}

/**
 * POST /vitals (RUM beacon): stores sampled, PII-free samples — normalized route pattern, metric, value, rating. No
 * user id, IP, user agent or query string. Batches are capped; malformed entries are dropped.
 */
export async function recordVitals(entries: unknown): Promise<{ stored: number }> {
  const list = (Array.isArray(entries) ? entries : [entries]).slice(0, 10);
  const samples = list.map(parseVitalSample).filter((s): s is NonNullable<typeof s> => s !== null);
  if (!samples.length) return { stored: 0 };
  await q(
    `INSERT INTO web_vitals_samples (route, metric, value, rating, nav_type)
     SELECT * FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[])`,
    [samples.map((s) => s.route), samples.map((s) => s.metric), samples.map((s) => s.value), samples.map((s) => s.rating), samples.map((s) => s.navType)],
  );
  return { stored: samples.length };
}

/** Worker retention for RUM samples (90 days). */
export async function purgeOldVitals(days = 90): Promise<number> {
  const r = await q<{ n: number }>("WITH d AS (DELETE FROM web_vitals_samples WHERE created_at < now() - make_interval(days => $1) RETURNING 1) SELECT count(*)::int AS n FROM d", [days]);
  return r[0]?.n ?? 0;
}
