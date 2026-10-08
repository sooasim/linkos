// event module — Events & Networking: 행사 워크스페이스, 참가 opt-in, 행사 매칭(공유하기로 한 데이터만 사용),
// F-142 참가자 등록(CSV/붙여넣기 · 사전가입 → 참가 코드 입장 시 이메일로 연결)
import { MAX_ATTENDEE_ROWS, type AttendeeRow, generateShortCode, normalizeEmail, parseAttendeeCsv, registrantKeySource } from "@linkos/domain";
import { z } from "zod";
import { one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, rateLimit, sha256 } from "../lib/platform";
import { primaryProfileId } from "./card";
import { listMatches } from "./ai";

export const eventInput = z.object({
  name: z.string().trim().min(1).max(200),
  venue: z.string().trim().max(200).nullish(),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
});

export async function createEvent(ctx: Ctx, input: z.infer<typeof eventInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const e = await one<{ id: string; join_code: string }>(
      "INSERT INTO events (name, venue, starts_at, ends_at, owner_user_id, join_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, join_code",
      [input.name, input.venue ?? null, input.startsAt ?? null, input.endsAt ?? null, userId, generateShortCode()],
      c,
    );
    const pid = await primaryProfileId(userId, c);
    await c.query("INSERT INTO event_attendees (event_id, user_id, profile_id, opt_in, metadata) VALUES ($1,$2,$3,true,$4)", [e!.id, userId, pid, JSON.stringify({ role: "organizer" })]);
    await audit(c, ctx, "event.created", "event", e!.id);
    return { id: e!.id, joinCode: e!.join_code };
  });
}

export async function joinEvent(ctx: Ctx, joinCode: string, optIn: boolean) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<{ id: string }>("SELECT id FROM events WHERE join_code=$1", [joinCode.toUpperCase()]);
  if (!e) throw notFound("event");
  const pid = await primaryProfileId(ctx.userId);
  if (!pid) throw new ApiError(422, "profile_required", "행사 참여 전 내 명함을 만들어 주세요.");
  const existing = await one<{ id: string }>("SELECT id FROM event_attendees WHERE event_id=$1 AND user_id=$2", [e.id, ctx.userId]);
  if (existing) await q("UPDATE event_attendees SET opt_in=$2, profile_id=$3 WHERE id=$1", [existing.id, optIn, pid]);
  else {
    // F-142 사전가입: the organizer pre-registered this person by e-mail → the join claims that row (no duplicate)
    const u = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [ctx.userId]);
    const email = u?.email ? normalizeEmail(u.email) : null;
    const claimed = email
      ? await one<{ id: string }>(
          "UPDATE event_attendees SET user_id=$3, profile_id=$4, opt_in=$5 WHERE event_id=$1 AND user_id IS NULL AND registrant_key=$2 RETURNING id",
          [e.id, sha256(registrantKeySource({ fullName: "", email, company: null })), ctx.userId, pid, optIn],
        )
      : null;
    if (!claimed) await q("INSERT INTO event_attendees (event_id, user_id, profile_id, opt_in) VALUES ($1,$2,$3,$4)", [e.id, ctx.userId, pid, optIn]);
  }
  return { eventId: e.id, optIn };
}

export async function listMyEvents(userId: string) {
  return q<any>(
    `SELECT e.id, e.name, e.venue, e.starts_at, e.join_code, e.owner_user_id = $1 AS is_owner, ea.opt_in,
       (SELECT count(*)::int FROM event_attendees x WHERE x.event_id=e.id AND x.user_id IS NOT NULL) AS attendees,
       (SELECT count(*)::int FROM encounters en WHERE en.event_id=e.id AND en.owner_user_id=$1) AS my_leads
     FROM events e JOIN event_attendees ea ON ea.event_id=e.id AND ea.user_id=$1 ORDER BY COALESCE(e.starts_at, now()) DESC`,
    [userId],
  );
}

export async function getEvent(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<any>(
    `SELECT e.*, ea.opt_in FROM events e JOIN event_attendees ea ON ea.event_id=e.id AND ea.user_id=$2 WHERE e.id=$1`,
    [id, ctx.userId],
  );
  if (!e) throw notFound("event");
  const leads = await q<any>(
    `SELECT c.id, c.full_name, co.name AS company, en.occurred_at FROM encounters en JOIN contacts c ON c.id=en.contact_id LEFT JOIN companies co ON co.id=c.company_id
     WHERE en.event_id=$1 AND en.owner_user_id=$2 ORDER BY en.occurred_at DESC`,
    [id, ctx.userId],
  );
  const attendees = await one<{ n: number; opted: number; registered: number }>(
    "SELECT count(*) FILTER (WHERE user_id IS NOT NULL)::int AS n, count(*) FILTER (WHERE opt_in AND user_id IS NOT NULL)::int AS opted, count(*) FILTER (WHERE registrant_key IS NOT NULL)::int AS registered FROM event_attendees WHERE event_id=$1",
    [id],
  );
  return {
    id: e.id,
    name: e.name,
    venue: e.venue,
    startsAt: e.starts_at,
    joinCode: e.join_code,
    isOwner: e.owner_user_id === ctx.userId,
    optIn: e.opt_in,
    attendees: attendees?.n ?? 0,
    optedIn: attendees?.opted ?? 0,
    registered: attendees?.registered ?? 0,
    leads: leads.map((l) => ({ contactId: l.id, fullName: l.full_name, company: l.company, at: l.occurred_at })),
  };
}

export async function eventMatches(ctx: Ctx, id: string) {
  await getEvent(ctx, id);
  return listMatches(ctx, { eventId: id });
}

// ---------- F-142 참가자 등록 (organizer = event owner, session auth) ----------
const attendeeRow = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).nullish(),
  company: z.string().trim().max(160).nullish(),
  jobTitle: z.string().trim().max(160).nullish(),
});
export const attendeeImportInput = z
  .object({
    /** raw CSV / TSV / pasted spreadsheet text — parsed server-side with the same domain parser as the preview */
    csv: z.string().max(1_000_000).optional(),
    attendees: z.array(attendeeRow).max(MAX_ATTENDEE_ROWS).optional(),
    source: z.enum(["csv", "paste", "api"]).default("csv"),
  })
  .refine((v) => (v.csv !== undefined) !== (v.attendees !== undefined), "csv 또는 attendees 중 하나만 보내세요.");

async function requireEventOwner(ctx: Ctx, eventId: string) {
  if (!ctx.userId) throw unauthorized();
  const e = await one<{ owner_user_id: string | null }>("SELECT owner_user_id FROM events WHERE id=$1", [eventId]);
  if (!e) throw notFound("event");
  if (e.owner_user_id !== ctx.userId) throw forbidden("행사 주최자만 참가자를 관리할 수 있습니다.");
  return ctx.userId;
}

/**
 * POST /events/{id}/attendees — upsert pre-registered attendees. Idempotent by design: each person is keyed by
 * sha256(normalized e-mail | name+company), so re-uploading the same list updates rows instead of duplicating them.
 * Audit/log carry counts only (no names or e-mails — CLAUDE.md §3).
 */
export async function importAttendees(ctx: Ctx, eventId: string, input: z.infer<typeof attendeeImportInput>) {
  const userId = await requireEventOwner(ctx, eventId);
  await rateLimit(`event:import:${userId}`, 30, 3600);
  let rows: AttendeeRow[];
  const errors: { line: number; reason: string }[] = [];
  if (input.csv !== undefined) {
    const parsed = parseAttendeeCsv(input.csv);
    rows = parsed.rows;
    errors.push(...parsed.errors);
  } else {
    rows = [];
    const seen = new Set<string>();
    (input.attendees ?? []).forEach((a, i) => {
      const email = a.email ? normalizeEmail(a.email) : null;
      if (a.email && !email) return void errors.push({ line: i + 1, reason: "invalid_email" });
      const row = { fullName: a.fullName, email, company: a.company || null, jobTitle: a.jobTitle || null };
      const k = registrantKeySource(row);
      if (seen.has(k)) return void errors.push({ line: i + 1, reason: "duplicate" });
      seen.add(k);
      rows.push(row);
    });
  }
  if (!rows.length) throw badRequest("no_attendees", "등록할 참가자가 없습니다. 이름 열이 있는지 확인하세요.");
  return tx(async (c) => {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      const res = await one<{ inserted: boolean }>(
        `INSERT INTO event_attendees (event_id, full_name, email, company, job_title, registrant_key, registration_source, registered_by, registered_at, opt_in, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),false,'{"role":"attendee"}')
         ON CONFLICT (event_id, registrant_key) WHERE registrant_key IS NOT NULL DO UPDATE
           SET full_name=EXCLUDED.full_name, email=COALESCE(EXCLUDED.email, event_attendees.email), company=EXCLUDED.company, job_title=EXCLUDED.job_title, registration_source=EXCLUDED.registration_source
         RETURNING (xmax = 0) AS inserted`,
        [eventId, r.fullName, r.email, r.company, r.jobTitle, sha256(registrantKeySource(r)), input.source, userId],
        c,
      );
      if (res?.inserted) inserted++;
      else updated++;
    }
    await audit(c, ctx, "event.attendees_imported", "event", eventId, { inserted, updated, skipped: errors.length, source: input.source });
    return { inserted, updated, skipped: errors.length, errors: errors.slice(0, 50) };
  });
}

/** GET /events/{id}/attendees — owner only: joined attendees (with role/opt-in) and pre-registered people. */
export async function listAttendees(ctx: Ctx, eventId: string) {
  await requireEventOwner(ctx, eventId);
  const rows = await q<any>(
    `SELECT ea.id, ea.user_id, ea.opt_in, ea.metadata->>'role' AS role, ea.full_name, ea.email, ea.company, ea.job_title, ea.registration_source,
       p.name AS profile_name, p.company AS profile_company, p.job_title AS profile_job_title, u.display_name
     FROM event_attendees ea LEFT JOIN profiles p ON p.id = ea.profile_id LEFT JOIN users u ON u.id = ea.user_id
     WHERE ea.event_id=$1 ORDER BY (ea.user_id IS NULL), COALESCE(ea.registered_at, ea.created_at) DESC LIMIT 2000`,
    [eventId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    userId: (r.user_id ?? null) as string | null,
    status: r.user_id ? ("joined" as const) : ("registered" as const),
    role: (r.role ?? "attendee") as string,
    optIn: !!r.opt_in,
    fullName: (r.profile_name ?? r.full_name ?? r.display_name ?? null) as string | null,
    company: (r.profile_company ?? r.company ?? null) as string | null,
    jobTitle: (r.profile_job_title ?? r.job_title ?? null) as string | null,
    email: (r.email ?? null) as string | null,
    preRegistered: !!r.registration_source,
  }));
}

/** DELETE /events/{id}/attendees/{attendeeId} — owner removes a pre-registered (not yet joined) person. */
export async function removeRegistrant(ctx: Ctx, eventId: string, attendeeId: string) {
  await requireEventOwner(ctx, eventId);
  const r = await one<{ id: string }>("DELETE FROM event_attendees WHERE id=$1 AND event_id=$2 AND user_id IS NULL RETURNING id", [attendeeId, eventId]);
  if (!r) throw notFound("attendee");
  await audit(pool(), ctx, "event.registrant_removed", "event", eventId, { attendee: attendeeId });
  return { removed: true };
}
