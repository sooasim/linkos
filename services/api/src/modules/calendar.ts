// calendar module — F-087 일정 후보, F-107 캘린더 예약(공개 예약 링크), F-108 일정 승인, F-118 Google Calendar, F-119 Outlook 캘린더,
// F-157 Room 미팅 예약, F-146 행사 미팅 요청. 모든 일정은 "후보 → 사용자 승인 → 캘린더 반영"이며 .ics 폴백을 제공한다.
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WINDOWS,
  type Interval,
  type WeeklyWindow,
  buildIcs,
  computeFreeSlots,
  generateToken,
  isValidTimeZone,
  parseScheduleHint,
  validateWindows,
} from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { type Ctx, appOrigin, audit, log, rateLimit, sha256 } from "../lib/platform";
import { structured } from "../lib/llm";
import { graphBase, providerAccount, providerFetch } from "./crm";
import { GOOGLE_SCOPE, SyncConflict, googleAccessToken, googleAccountWithScope, gurl, processSyncJobs, seal, unseal } from "./integration";
import { notify } from "./push";

// ---------- connected calendar ----------
export type CalendarProvider = "google" | "microsoft";

export async function calendarAccount(userId: string, db: Db = pool()): Promise<{ id: string; provider: CalendarProvider } | null> {
  const g = await googleAccountWithScope(userId, GOOGLE_SCOPE.calendarEvents, db);
  if (g) return { id: g.id, provider: "google" };
  const m = await providerAccount(userId, "microsoft", db);
  if (m && m.scopes.some((s) => /Calendars\.ReadWrite/i.test(s))) return { id: m.id, provider: "microsoft" };
  return null;
}

/** Busy intervals from the connected calendar (Google free/busy or Graph getSchedule) + LINKOS's own held slots. */
export async function busyIntervals(userId: string, from: Date, to: Date): Promise<{ busy: Interval[]; source: "google" | "microsoft" | "local"; error?: string }> {
  const own = await q<{ starts_at: Date; ends_at: Date }>(
    "SELECT starts_at, ends_at FROM calendar_candidates WHERE owner_user_id=$1 AND status IN ('approved','pending_approval') AND ends_at > $2 AND starts_at < $3",
    [userId, from, to],
  );
  const busy: Interval[] = own.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
  const g = await one<{ id: string; scopes: string[] }>("SELECT id, scopes FROM integration_accounts WHERE user_id=$1 AND provider='google' AND status='active'", [userId]);
  try {
    if (g && (g.scopes.includes(GOOGLE_SCOPE.calendarFreeBusy) || g.scopes.includes(GOOGLE_SCOPE.calendarEvents))) {
      const token = await googleAccessToken(g.id);
      const res = await fetch(gurl("calendar", "/freeBusy"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
      });
      if (!res.ok) throw new ApiError(502, `google_freebusy_${res.status}`);
      const j = (await res.json()) as { calendars: Record<string, { busy: { start: string; end: string }[]; errors?: unknown[] }> };
      for (const b of j.calendars?.primary?.busy ?? []) busy.push({ start: new Date(b.start), end: new Date(b.end) });
      return { busy, source: "google" };
    }
    const m = await providerAccount(userId, "microsoft");
    if (m && m.scopes.some((s) => /Calendars\.ReadWrite/i.test(s)) && m.metadata.accountEmail) {
      const res = await providerFetch(m, `${graphBase()}/me/calendar/getSchedule`, {
        method: "POST",
        headers: { Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({ schedules: [m.metadata.accountEmail], startTime: { dateTime: from.toISOString().slice(0, 19), timeZone: "UTC" }, endTime: { dateTime: to.toISOString().slice(0, 19), timeZone: "UTC" }, availabilityViewInterval: 30 }),
      });
      if (!res.ok) throw new ApiError(502, `graph_schedule_${res.status}`);
      const j = (await res.json()) as { value: { scheduleItems?: { status: string; start: { dateTime: string }; end: { dateTime: string } }[] }[] };
      for (const it of j.value?.[0]?.scheduleItems ?? []) if (it.status !== "free") busy.push({ start: new Date(`${it.start.dateTime.replace(/Z?$/, "")}Z`), end: new Date(`${it.end.dateTime.replace(/Z?$/, "")}Z`) });
      return { busy, source: "microsoft" };
    }
  } catch (e) {
    log("warn", "calendar.busy_failed", { error: (e as Error).message });
    return { busy, source: "local", error: (e as ApiError).code ?? "busy_lookup_failed" };
  }
  return { busy, source: "local" };
}

// ---------- candidates ----------
export interface CandidateRow {
  id: string;
  owner_user_id: string;
  source: string;
  meeting_id: string | null;
  contact_id: string | null;
  room_id: string | null;
  event_id: string | null;
  booking_page_id: string | null;
  group_key: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: string;
  provenance: string;
  confidence: string | number | null;
  source_text: string | null;
  attendees: { email: string; name?: string | null }[];
  requester_name: string | null;
  requester_email: string | null;
  note: string | null;
  version: number;
  calendar_provider: string | null;
  decided_at: Date | null;
  created_at: Date;
}

function toCandidate(r: CandidateRow, external?: { external_id: string; remote_url: string | null } | null) {
  return {
    id: r.id,
    source: r.source,
    meetingId: r.meeting_id,
    contactId: r.contact_id,
    roomId: r.room_id,
    eventId: r.event_id,
    title: r.title,
    description: r.description,
    location: r.location,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    timezone: r.timezone,
    status: r.status,
    provenance: r.provenance,
    confidence: r.confidence == null ? null : Number(r.confidence),
    sourceText: r.source_text,
    attendees: r.attendees,
    requester: r.requester_email ? { name: r.requester_name, email: r.requester_email } : null,
    note: r.note,
    version: r.version,
    calendarProvider: r.calendar_provider,
    calendarEvent: external ? { id: external.external_id, url: external.remote_url } : null,
    icsUrl: `/api/v1/calendar/candidates/${r.id}/ics`,
    createdAt: r.created_at,
  };
}

const tzSchema = z.string().max(60).refine(isValidTimeZone, "invalid time zone");

export const listCandidatesQuery = z.object({
  status: z.enum(["proposed", "pending_approval", "approved", "declined", "cancelled", "superseded"]).optional(),
  meetingId: z.string().uuid().optional(),
  roomId: z.string().uuid().optional(),
});

export async function listCandidates(userId: string, f: z.infer<typeof listCandidatesQuery> = {}) {
  const params: unknown[] = [userId];
  let where = "c.owner_user_id=$1";
  if (f.status) {
    params.push(f.status);
    where += ` AND c.status=$${params.length}`;
  } else where += " AND c.status IN ('proposed','pending_approval','approved')";
  if (f.meetingId) {
    params.push(f.meetingId);
    where += ` AND c.meeting_id=$${params.length}`;
  }
  if (f.roomId) {
    params.push(f.roomId);
    where += ` AND c.room_id=$${params.length}`;
  }
  const rows = await q<CandidateRow & { external_id: string | null; remote_url: string | null }>(
    `SELECT c.*, em.external_id, em.remote_url FROM calendar_candidates c
     LEFT JOIN integration_accounts a ON a.user_id = c.owner_user_id AND a.provider = c.calendar_provider
     LEFT JOIN external_mappings em ON em.integration_account_id = a.id AND em.entity_type='calendar_event' AND em.local_id = c.id
     WHERE ${where} ORDER BY c.starts_at LIMIT 200`,
    params,
  );
  return rows.map((r) => toCandidate(r, r.external_id ? { external_id: r.external_id, remote_url: r.remote_url } : null));
}

async function insertCandidate(db: Db, userId: string, c: Partial<CandidateRow> & { source: string; title: string; starts_at: Date; ends_at: Date }) {
  const r = await one<CandidateRow>(
    `INSERT INTO calendar_candidates (owner_user_id, source, meeting_id, contact_id, room_id, event_id, booking_page_id, group_key, title, description, location, starts_at, ends_at, timezone, status, provenance, confidence, source_text, attendees, requester_name, requester_email, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [
      userId,
      c.source,
      c.meeting_id ?? null,
      c.contact_id ?? null,
      c.room_id ?? null,
      c.event_id ?? null,
      c.booking_page_id ?? null,
      c.group_key ?? null,
      c.title.slice(0, 200),
      c.description ?? null,
      c.location ?? null,
      c.starts_at,
      c.ends_at,
      c.timezone ?? "Asia/Seoul",
      c.status ?? "proposed",
      c.provenance ?? "user",
      c.confidence ?? null,
      c.source_text ?? null,
      JSON.stringify(c.attendees ?? []),
      c.requester_name ?? null,
      c.requester_email ?? null,
      c.note ?? null,
    ],
    db,
  );
  return r!;
}

const slotSchema = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() }).refine((s) => new Date(s.endsAt) > new Date(s.startsAt), "endsAt must be after startsAt");

export const manualCandidatesInput = z.object({
  title: z.string().trim().min(1).max(200),
  contactId: z.string().uuid().nullish(),
  meetingId: z.string().uuid().nullish(),
  location: z.string().max(200).nullish(),
  timezone: tzSchema.default("Asia/Seoul"),
  slots: z.array(slotSchema).min(1).max(5),
});

export async function createCandidates(ctx: Ctx, input: z.infer<typeof manualCandidatesInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  if (input.contactId && !(await one("SELECT 1 FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [input.contactId, userId]))) throw notFound("contact");
  if (input.meetingId && !(await one("SELECT 1 FROM meetings WHERE id=$1 AND owner_user_id=$2", [input.meetingId, userId]))) throw notFound("meeting");
  const attendees = input.contactId ? await contactAttendees(userId, [input.contactId]) : [];
  return tx(async (c) => {
    const group = randomUUID();
    const out = [];
    for (const s of input.slots) {
      out.push(await insertCandidate(c, userId, { source: input.meetingId ? "meeting" : "manual", meeting_id: input.meetingId ?? null, contact_id: input.contactId ?? null, group_key: group, title: input.title, location: input.location ?? null, starts_at: new Date(s.startsAt), ends_at: new Date(s.endsAt), timezone: input.timezone, attendees }));
    }
    await audit(c, ctx, "calendar.candidates.created", null, null, { count: out.length });
    return out.map((r) => toCandidate(r));
  });
}

async function contactAttendees(userId: string, contactIds: string[], db: Db = pool()) {
  if (!contactIds.length) return [];
  const rows = await q<{ email: string | null; full_name: string }>("SELECT email, full_name FROM contacts WHERE owner_user_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [userId, contactIds], db);
  return rows.filter((r) => r.email).map((r) => ({ email: r.email!, name: r.full_name }));
}

// ---------- F-087 meeting → schedule candidates ----------
export const fromMeetingInput = z.object({ hint: z.string().max(300).optional(), timezone: tzSchema.default("Asia/Seoul"), durationMin: z.number().int().min(15).max(240).default(60) });

const HintSchema = z.object({ candidates: z.array(z.object({ startLocal: z.string(), confidence: z.number() })) });

/**
 * Turns a meeting's next-meeting wording (nextMeetingHint / next_meeting_at) into proposed slots.
 * Rule parser first; the LLM is only asked when rules find no date AND the text contains digits or weekday words,
 * and its output must still be a future date. Candidates are suggestions: status=proposed, provenance+confidence recorded.
 */
export async function proposeFromMeeting(ctx: Ctx, meetingId: string, input: z.infer<typeof fromMeetingInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const m = await one<{ id: string; title: string | null; next_meeting_at: Date | null; purpose: string | null }>("SELECT id, title, next_meeting_at, purpose FROM meetings WHERE id=$1 AND owner_user_id=$2", [meetingId, userId]);
  if (!m) throw notFound("meeting");
  const now = new Date();
  let slots: { start: Date; end: Date; confidence: number; provenance: "rules" | "ai_inferred" | "user" }[] = [];
  const hint = input.hint?.trim() ?? "";
  if (hint) {
    slots = parseScheduleHint(hint, now, input.timezone, input.durationMin).map((s) => ({ ...s, provenance: "rules" as const }));
    if (!slots.length && /\d|[월화수목금토일]요일|monday|tuesday|wednesday|thursday|friday/i.test(hint)) {
      const llm = await structured({
        schema: HintSchema,
        task: `Convert the meeting-time wording into up to 3 concrete local start times (format YYYY-MM-DDTHH:mm, time zone ${input.timezone}). Today is ${now.toISOString().slice(0, 10)}. Only use dates/times the wording supports; return an empty list if it is too vague.`,
        data: hint,
        promptVersion: "schedule-hint-1",
        ownerUserId: userId,
        kind: "schedule_hint",
        sourceIds: [meetingId],
      });
      for (const c of llm?.output.candidates ?? []) {
        const mm = c.startLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
        if (!mm) continue;
        const { zonedToUtc } = await import("@linkos/domain");
        const start = zonedToUtc(Number(mm[1]), Number(mm[2]), Number(mm[3]), Number(mm[4]) * 60 + Number(mm[5]), input.timezone);
        if (start <= now) continue;
        slots.push({ start, end: new Date(start.getTime() + input.durationMin * 60000), confidence: Math.min(0.6, c.confidence), provenance: "ai_inferred" });
      }
    }
  } else if (m.next_meeting_at && new Date(m.next_meeting_at) > now) {
    const start = new Date(m.next_meeting_at);
    slots = [{ start, end: new Date(start.getTime() + input.durationMin * 60000), confidence: 1, provenance: "user" }];
  }
  if (!slots.length) return { candidates: [], message: "일정으로 해석할 수 있는 날짜 표현이 없어요. 직접 시간을 골라 주세요." };
  const parts = await q<{ contact_id: string }>("SELECT contact_id FROM meeting_participants WHERE meeting_id=$1", [meetingId]);
  const attendees = await contactAttendees(userId, parts.map((p) => p.contact_id));
  const busy = await busyIntervals(userId, new Date(Math.min(...slots.map((s) => s.start.getTime()))), new Date(Math.max(...slots.map((s) => s.end.getTime()))));
  const rows = await tx(async (c) => {
    // replace earlier un-decided suggestions for this meeting (idempotent re-run)
    await c.query("UPDATE calendar_candidates SET status='superseded' WHERE owner_user_id=$1 AND meeting_id=$2 AND status='proposed' AND provenance <> 'user'", [userId, meetingId]);
    const group = randomUUID();
    const out = [];
    for (const s of slots.slice(0, 3)) {
      out.push(
        await insertCandidate(c, userId, {
          source: "meeting",
          meeting_id: meetingId,
          contact_id: parts[0]?.contact_id ?? null,
          group_key: group,
          title: `${m.title ?? "미팅"} 후속`,
          starts_at: s.start,
          ends_at: s.end,
          timezone: input.timezone,
          provenance: s.provenance,
          confidence: s.confidence,
          source_text: hint || null,
          attendees,
        }),
      );
    }
    await audit(c, ctx, "calendar.candidates.proposed", "meeting", meetingId, { count: out.length, provenance: slots[0]!.provenance });
    return out;
  });
  return {
    candidates: rows.map((r) => ({ ...toCandidate(r), conflictsWithCalendar: busy.busy.some((b) => b.start < r.ends_at && r.starts_at < b.end) })),
    busySource: busy.source,
  };
}

// ---------- F-108 approval → calendar ----------
export const decideInput = z.object({
  approve: z.boolean(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  notifyAttendees: z.boolean().default(false),
});

async function enqueueCalendarJob(c: pg.PoolClient, userId: string, candidateId: string, version: number, op: "upsert" | "delete", notifyAttendees: boolean) {
  const acct = await calendarAccount(userId, c);
  if (!acct) return null;
  await c.query("UPDATE calendar_candidates SET calendar_provider=$2 WHERE id=$1", [candidateId, acct.provider]);
  await c.query(
    `INSERT INTO sync_jobs (integration_account_id, job_type, payload, idempotency_key, provider) VALUES ($1,'calendar.event.upsert',$2,$3,$4)
     ON CONFLICT (integration_account_id, idempotency_key) DO NOTHING`,
    [acct.id, JSON.stringify({ candidateId, op, notifyAttendees }), `cal:${candidateId}:v${version}:${op}`, acct.provider],
  );
  return acct;
}

async function lastCalendarJob(candidateId: string) {
  return one<{ status: string; last_error: string | null }>("SELECT status, last_error FROM sync_jobs WHERE job_type='calendar.event.upsert' AND payload->>'candidateId'=$1 ORDER BY scheduled_at DESC LIMIT 1", [candidateId]);
}

export async function decideCandidate(ctx: Ctx, id: string, input: z.infer<typeof decideInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const result = await tx(async (c) => {
    const cand = await one<CandidateRow>("SELECT * FROM calendar_candidates WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, userId], c);
    if (!cand) throw notFound("candidate");
    if (["declined", "cancelled", "superseded"].includes(cand.status)) throw conflict("candidate_closed", "이미 종료된 후보입니다.");
    if (!input.approve) {
      if (cand.status === "approved") throw conflict("already_approved", "확정된 일정은 취소를 사용하세요.");
      await c.query("UPDATE calendar_candidates SET status='declined', decided_at=now() WHERE id=$1", [id]);
      await audit(c, ctx, "calendar.candidate.declined", null, id, { source: cand.source });
      return { acct: null, version: cand.version };
    }
    const starts = input.startsAt ? new Date(input.startsAt) : cand.starts_at;
    const ends = input.endsAt ? new Date(input.endsAt) : input.startsAt ? new Date(starts.getTime() + (cand.ends_at.getTime() - cand.starts_at.getTime())) : cand.ends_at;
    if (ends <= starts) throw badRequest("invalid_range");
    const changed = cand.status !== "approved" || starts.getTime() !== new Date(cand.starts_at).getTime() || ends.getTime() !== new Date(cand.ends_at).getTime() || (input.title && input.title !== cand.title);
    const version = cand.status === "approved" && changed ? cand.version + 1 : cand.version;
    await c.query("UPDATE calendar_candidates SET status='approved', starts_at=$2, ends_at=$3, title=COALESCE($4,title), version=$5, decided_at=now() WHERE id=$1", [id, starts, ends, input.title ?? null, version]);
    if (cand.group_key) await c.query("UPDATE calendar_candidates SET status='superseded' WHERE group_key=$1 AND id<>$2 AND status IN ('proposed','pending_approval')", [cand.group_key, id]);
    if (cand.meeting_id) await c.query("UPDATE meetings SET next_meeting_at=$3 WHERE id=$1 AND owner_user_id=$2", [cand.meeting_id, userId, starts]);
    if (cand.room_id) await c.query("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [cand.room_id, userId, `미팅 확정: ${starts.toISOString().slice(0, 16).replace("T", " ")} UTC · ${input.title ?? cand.title}`]);
    const acct = changed ? await enqueueCalendarJob(c, userId, id, version, "upsert", input.notifyAttendees) : null;
    await audit(c, ctx, "calendar.candidate.approved", null, id, { source: cand.source, version, provider: acct?.provider ?? "ics_only", notifyAttendees: input.notifyAttendees });
    return { acct, version };
  });
  if (result.acct) await processSyncJobs(20, result.acct.id).catch((e) => log("warn", "calendar.inline_failed", { error: (e as Error).message }));
  const row = await one<CandidateRow>("SELECT * FROM calendar_candidates WHERE id=$1", [id]);
  const job = await lastCalendarJob(id);
  return { ...toCandidate(row!), calendarSync: result.acct ? { provider: result.acct.provider, status: job?.status ?? "queued", error: job?.last_error ?? null } : { provider: null, status: "ics_only" } };
}

export async function cancelCandidate(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const acct = await tx(async (c) => {
    const cand = await one<CandidateRow>("SELECT * FROM calendar_candidates WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, userId], c);
    if (!cand) throw notFound("candidate");
    await c.query("UPDATE calendar_candidates SET status='cancelled', version=version+1, decided_at=now() WHERE id=$1", [id]);
    const a = cand.status === "approved" && cand.calendar_provider ? await enqueueCalendarJob(c, userId, id, cand.version + 1, "delete", false) : null;
    await audit(c, ctx, "calendar.candidate.cancelled", null, id);
    return a;
  });
  if (acct) await processSyncJobs(20, acct.id).catch(() => 0);
  return { id, status: "cancelled" };
}

export async function candidateIcs(userId: string, id: string): Promise<{ body: string; filename: string }> {
  const c = await one<CandidateRow>("SELECT * FROM calendar_candidates WHERE id=$1 AND owner_user_id=$2", [id, userId]);
  if (!c) throw notFound("candidate");
  return { body: icsFor(c), filename: `linkos-${c.starts_at.toISOString().slice(0, 10)}.ics` };
}

function icsFor(c: CandidateRow, extraAttendees: { email: string; name?: string | null }[] = []) {
  return buildIcs({
    uid: `${c.id}@linkos`,
    start: new Date(c.starts_at),
    end: new Date(c.ends_at),
    summary: c.title,
    description: [c.description, c.note].filter(Boolean).join("\n") || null,
    location: c.location,
    attendees: [...c.attendees, ...extraAttendees],
    sequence: c.version,
    status: c.status === "cancelled" ? "CANCELLED" : c.status === "approved" ? "CONFIRMED" : "TENTATIVE",
  });
}

/** Sync job: create/update/delete the external event. Idempotent create: Google client-supplied event id, Graph transactionId. */
export async function runCalendarJob(accountId: string, provider: string, payload: { candidateId: string; op: "upsert" | "delete"; notifyAttendees?: boolean; force?: boolean }) {
  const c = await one<CandidateRow>("SELECT cc.* FROM calendar_candidates cc JOIN integration_accounts a ON a.user_id=cc.owner_user_id WHERE cc.id=$1 AND a.id=$2", [payload.candidateId, accountId]);
  if (!c) throw new ApiError(404, "candidate_not_found");
  const map = await one<{ external_id: string; external_etag: string | null }>("SELECT external_id, external_etag FROM external_mappings WHERE integration_account_id=$1 AND entity_type='calendar_event' AND local_id=$2", [accountId, c.id]);
  if (payload.op === "delete" && !map) return;
  const description = [c.description, c.note, "— LINKOS에서 승인한 일정"].filter(Boolean).join("\n");
  let externalId: string;
  let etag: string | null = null;
  let url: string | null = null;
  if (provider === "google") {
    const token = await googleAccessToken(accountId);
    const sendUpdates = payload.notifyAttendees ? "all" : "none";
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const eventId = c.id.replace(/-/g, ""); // base32hex-safe, deterministic → retried inserts can't duplicate
    if (payload.op === "delete") {
      const res = await fetch(gurl("calendar", `/calendars/primary/events/${encodeURIComponent(map!.external_id)}?sendUpdates=${sendUpdates}`), { method: "DELETE", headers: h });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new ApiError(res.status, `google_calendar_${res.status}`, `Calendar delete ${res.status}`);
      await q("DELETE FROM external_mappings WHERE integration_account_id=$1 AND entity_type='calendar_event' AND local_id=$2", [accountId, c.id]);
      return { externalId: map!.external_id };
    }
    const body = {
      summary: c.title,
      description,
      location: c.location ?? undefined,
      start: { dateTime: new Date(c.starts_at).toISOString(), timeZone: c.timezone },
      end: { dateTime: new Date(c.ends_at).toISOString(), timeZone: c.timezone },
      attendees: c.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
      source: { title: "LINKOS", url: `${appOrigin()}/app/calendar` },
    };
    let res: Response;
    if (map) {
      res = await fetch(gurl("calendar", `/calendars/primary/events/${encodeURIComponent(map.external_id)}?sendUpdates=${sendUpdates}`), {
        method: "PATCH",
        headers: { ...h, ...(map.external_etag && !payload.force ? { "If-Match": map.external_etag } : {}) },
        body: JSON.stringify(body),
      });
      if (res.status === 412) throw new SyncConflict("Google Calendar 일정이 다른 곳에서 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: map.external_etag });
    } else {
      res = await fetch(gurl("calendar", `/calendars/primary/events?sendUpdates=${sendUpdates}`), { method: "POST", headers: h, body: JSON.stringify({ ...body, id: eventId }) });
      if (res.status === 409) res = await fetch(gurl("calendar", `/calendars/primary/events/${eventId}`), { headers: h }); // created by an earlier attempt
    }
    if (!res.ok) throw new ApiError(res.status, `google_calendar_${res.status}`, `Calendar ${res.status}`);
    const j = (await res.json()) as { id: string; etag: string; htmlLink?: string };
    externalId = j.id;
    etag = j.etag;
    url = j.htmlLink ?? null;
  } else if (provider === "microsoft") {
    const a = await providerAccount((await one<{ user_id: string }>("SELECT user_id FROM integration_accounts WHERE id=$1", [accountId]))!.user_id, "microsoft");
    if (!a) throw new ApiError(401, "microsoft_reauth_required");
    if (payload.op === "delete") {
      const res = await providerFetch(a, `${graphBase()}/me/events/${encodeURIComponent(map!.external_id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new ApiError(res.status, `graph_${res.status}`, `Graph delete ${res.status}`);
      await q("DELETE FROM external_mappings WHERE integration_account_id=$1 AND entity_type='calendar_event' AND local_id=$2", [accountId, c.id]);
      return { externalId: map!.external_id };
    }
    const body = {
      subject: c.title,
      body: { contentType: "text", content: description },
      start: { dateTime: new Date(c.starts_at).toISOString().slice(0, 19), timeZone: "UTC" },
      end: { dateTime: new Date(c.ends_at).toISOString().slice(0, 19), timeZone: "UTC" },
      location: c.location ? { displayName: c.location } : undefined,
      attendees: payload.notifyAttendees ? c.attendees.map((x) => ({ emailAddress: { address: x.email, name: x.name ?? x.email }, type: "required" })) : [],
      transactionId: c.id,
    };
    let res: Response;
    if (map) {
      const { transactionId: _t, ...patch } = body;
      res = await providerFetch(a, `${graphBase()}/me/events/${encodeURIComponent(map.external_id)}`, { method: "PATCH", headers: map.external_etag && !payload.force ? { "If-Match": map.external_etag } : {}, body: JSON.stringify(patch) });
      if (res.status === 412) throw new SyncConflict("Outlook 일정이 다른 곳에서 변경되어 덮어쓰지 않았습니다.", { externalId: map.external_id, etag: map.external_etag });
    } else {
      res = await providerFetch(a, `${graphBase()}/me/events`, { method: "POST", body: JSON.stringify(body) });
    }
    if (!res.ok) throw new ApiError(res.status, `graph_${res.status}`, `Graph events ${res.status}`);
    const j = (await res.json()) as { id: string; "@odata.etag"?: string; webLink?: string };
    externalId = j.id;
    etag = j["@odata.etag"] ?? null;
    url = j.webLink ?? null;
  } else {
    throw new ApiError(400, "calendar_provider_unsupported", provider);
  }
  await q(
    `INSERT INTO external_mappings (integration_account_id, entity_type, local_id, external_id, external_etag, remote_url, last_synced_at) VALUES ($1,'calendar_event',$2,$3,$4,$5,now())
     ON CONFLICT (integration_account_id, entity_type, local_id) DO UPDATE SET external_id=EXCLUDED.external_id, external_etag=EXCLUDED.external_etag, remote_url=COALESCE(EXCLUDED.remote_url, external_mappings.remote_url), last_synced_at=now()`,
    [accountId, c.id, externalId, etag, url],
  );
  return { externalId };
}

// ---------- F-107 booking pages ----------
const windowSchema = z.object({ weekday: z.number().int().min(0).max(6), start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440) });
export const bookingPageInput = z.object({
  title: z.string().trim().min(1).max(120),
  durationMin: z.number().int().min(10).max(240).default(30),
  bufferMin: z.number().int().min(0).max(120).default(0),
  minNoticeMin: z.number().int().min(0).max(14 * 1440).default(240),
  horizonDays: z.number().int().min(1).max(60).default(14),
  timezone: tzSchema.default("Asia/Seoul"),
  windows: z.array(windowSchema).max(50).default(DEFAULT_WINDOWS),
  location: z.string().max(200).nullish(),
  active: z.boolean().default(true),
});

interface BookingRow {
  id: string;
  owner_user_id: string;
  token_sealed: Buffer;
  title: string;
  duration_min: number;
  buffer_min: number;
  min_notice_min: number;
  horizon_days: number;
  timezone: string;
  windows: WeeklyWindow[];
  location: string | null;
  active: boolean;
  created_at: Date;
}

function bookingDto(r: BookingRow) {
  const token = unseal<{ t: string }>(r.token_sealed).t;
  return { id: r.id, title: r.title, durationMin: r.duration_min, bufferMin: r.buffer_min, minNoticeMin: r.min_notice_min, horizonDays: r.horizon_days, timezone: r.timezone, windows: r.windows, location: r.location, active: r.active, url: `${appOrigin()}/b/${token}`, createdAt: r.created_at };
}

export async function createBookingPage(ctx: Ctx, input: z.infer<typeof bookingPageInput>) {
  if (!ctx.userId) throw unauthorized();
  const errs = validateWindows(input.windows);
  if (errs.length) throw badRequest("invalid_windows", "가능 시간대를 확인하세요.", errs);
  const token = generateToken(24);
  const r = await one<BookingRow>(
    `INSERT INTO booking_pages (owner_user_id, token_hash, token_sealed, title, duration_min, buffer_min, min_notice_min, horizon_days, timezone, windows, location, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [ctx.userId, sha256(token), seal({ t: token }), input.title, input.durationMin, input.bufferMin, input.minNoticeMin, input.horizonDays, input.timezone, JSON.stringify(input.windows), input.location ?? null, input.active],
  );
  await audit(pool(), ctx, "calendar.booking_page.created", null, r!.id);
  return bookingDto(r!);
}

export async function updateBookingPage(ctx: Ctx, id: string, input: Partial<z.infer<typeof bookingPageInput>> & { rotateLink?: boolean }) {
  if (!ctx.userId) throw unauthorized();
  if (input.windows) {
    const errs = validateWindows(input.windows);
    if (errs.length) throw badRequest("invalid_windows", "가능 시간대를 확인하세요.", errs);
  }
  const token = input.rotateLink ? generateToken(24) : null;
  const r = await one<BookingRow>(
    `UPDATE booking_pages SET title=COALESCE($3,title), duration_min=COALESCE($4,duration_min), buffer_min=COALESCE($5,buffer_min), min_notice_min=COALESCE($6,min_notice_min),
       horizon_days=COALESCE($7,horizon_days), timezone=COALESCE($8,timezone), windows=COALESCE($9,windows), location=COALESCE($10,location), active=COALESCE($11,active),
       token_hash=COALESCE($12,token_hash), token_sealed=COALESCE($13,token_sealed), updated_at=now()
     WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [id, ctx.userId, input.title ?? null, input.durationMin ?? null, input.bufferMin ?? null, input.minNoticeMin ?? null, input.horizonDays ?? null, input.timezone ?? null, input.windows ? JSON.stringify(input.windows) : null, input.location ?? null, input.active ?? null, token ? sha256(token) : null, token ? seal({ t: token }) : null],
  );
  if (!r) throw notFound("booking_page");
  await audit(pool(), ctx, input.rotateLink ? "calendar.booking_page.link_rotated" : "calendar.booking_page.updated", null, id);
  return bookingDto(r);
}

export async function listBookingPages(userId: string) {
  const rows = await q<BookingRow>("SELECT * FROM booking_pages WHERE owner_user_id=$1 ORDER BY created_at DESC", [userId]);
  return rows.map(bookingDto);
}

async function pageByToken(token: string): Promise<BookingRow> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) throw notFound("booking_page");
  const r = await one<BookingRow>("SELECT * FROM booking_pages WHERE token_hash=$1 AND active", [sha256(token)]);
  if (!r) throw notFound("booking_page");
  return r;
}

async function freeSlotsFor(p: BookingRow, now = new Date()) {
  const to = new Date(now.getTime() + p.horizon_days * 86400000);
  const busy = await busyIntervals(p.owner_user_id, now, to);
  const slots = computeFreeSlots({ windows: p.windows, tz: p.timezone, from: now, days: p.horizon_days, durationMin: p.duration_min, bufferMin: p.buffer_min, minNoticeMin: p.min_notice_min, busy: busy.busy, now, limit: 300 });
  return { slots, source: busy.source };
}

/** Public (no auth): page info + free slots. Only the owner's display name and the page title are disclosed. */
export async function publicBookingPage(token: string) {
  const p = await pageByToken(token);
  const owner = await one<{ name: string | null; company: string | null }>(
    "SELECT COALESCE(p.name, u.display_name) AS name, p.company FROM users u LEFT JOIN LATERAL (SELECT name, company FROM profiles WHERE user_id=u.id ORDER BY is_primary DESC LIMIT 1) p ON true WHERE u.id=$1",
    [p.owner_user_id],
  );
  const { slots } = await freeSlotsFor(p);
  return { title: p.title, ownerName: owner?.name ?? "LINKOS 사용자", ownerCompany: owner?.company ?? null, durationMin: p.duration_min, timezone: p.timezone, location: p.location, slots: slots.map((s) => ({ startsAt: s.start.toISOString(), endsAt: s.end.toISOString() })) };
}

export const bookingRequestInput = z.object({
  startsAt: z.string().datetime(),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  note: z.string().trim().max(1000).optional(),
});

/** Guest picks a slot → pending_approval candidate for the owner (F-108). Slot is re-validated server side; one live request per slot. */
export async function requestBooking(token: string, input: z.infer<typeof bookingRequestInput>, ip: string) {
  await rateLimit(`booking:ip:${ip}`, 10, 3600);
  const p = await pageByToken(token);
  await rateLimit(`booking:page:${p.id}`, 60, 3600);
  const { slots } = await freeSlotsFor(p);
  const want = new Date(input.startsAt).getTime();
  const slot = slots.find((s) => s.start.getTime() === want);
  if (!slot) throw conflict("slot_unavailable", "선택한 시간은 더 이상 예약할 수 없습니다. 다른 시간을 골라 주세요.");
  try {
    return await tx(async (c) => {
      const cand = await insertCandidate(c, p.owner_user_id, {
        source: "booking",
        booking_page_id: p.id,
        title: `${p.title} · ${input.name}`,
        location: p.location,
        starts_at: slot.start,
        ends_at: slot.end,
        timezone: p.timezone,
        status: "pending_approval",
        provenance: "guest",
        attendees: [{ email: input.email, name: input.name }],
        requester_name: input.name,
        requester_email: input.email,
        note: input.note ?? null,
      });
      await notify(c, p.owner_user_id, { kind: "booking.requested", title: "새 미팅 예약 요청", body: `${input.name} · ${slot.start.toISOString().slice(0, 16).replace("T", " ")} UTC`, url: "/app/calendar", dedupeKey: `booking:${cand.id}` });
      await audit(c, { userId: null }, "calendar.booking.requested", null, cand.id, { page: p.id });
      return { requestId: cand.id, status: "pending_approval", startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString(), ics: icsFor(cand) };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("slot_unavailable", "방금 다른 분이 이 시간을 예약했어요.");
    throw e;
  }
}

// ---------- F-157 Connection Room meeting ----------
export const roomMeetingInput = z.object({ title: z.string().trim().min(1).max(200).optional(), timezone: tzSchema.default("Asia/Seoul"), location: z.string().max(200).nullish(), slots: z.array(slotSchema).min(1).max(5) });

export async function proposeRoomMeeting(ctx: Ctx, roomId: string, input: z.infer<typeof roomMeetingInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const room = await one<{ id: string; title: string; party_a_contact_id: string | null; party_b_contact_id: string | null; a_name: string | null; b_name: string | null }>(
    `SELECT r.id, r.title, i.party_a_contact_id, i.party_b_contact_id, a.full_name AS a_name, b.full_name AS b_name FROM connection_rooms r
     LEFT JOIN introductions i ON i.id = r.introduction_id LEFT JOIN contacts a ON a.id=i.party_a_contact_id LEFT JOIN contacts b ON b.id=i.party_b_contact_id
     WHERE r.id=$1 AND r.owner_user_id=$2`,
    [roomId, userId],
  );
  if (!room) throw notFound("room");
  const ids = [room.party_a_contact_id, room.party_b_contact_id].filter((x): x is string => Boolean(x));
  const attendees = await contactAttendees(userId, ids);
  const title = input.title ?? (room.a_name && room.b_name ? `${room.a_name} × ${room.b_name} 소개 미팅` : room.title);
  return tx(async (c) => {
    const group = randomUUID();
    const out = [];
    for (const s of input.slots) out.push(await insertCandidate(c, userId, { source: "room", room_id: roomId, group_key: group, title, location: input.location ?? null, starts_at: new Date(s.startsAt), ends_at: new Date(s.endsAt), timezone: input.timezone, attendees }));
    await c.query("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [roomId, userId, `미팅 후보 ${out.length}개를 제안했어요. 양측 확인 후 하나를 확정하세요.`]);
    await audit(c, ctx, "room.meeting_proposed", "room", roomId, { count: out.length });
    return out.map((r) => toCandidate(r));
  });
}

// ---------- F-146 event meeting requests ----------
export const eventMeetingInput = z.object({ targetProfileId: z.string().uuid(), message: z.string().trim().max(500).optional(), location: z.string().trim().max(200).optional(), slots: z.array(slotSchema).min(1).max(3) });

export async function requestEventMeeting(ctx: Ctx, eventId: string, input: z.infer<typeof eventMeetingInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`event_meeting:${userId}`, 20, 3600);
  const me = await one("SELECT 1 FROM event_attendees WHERE event_id=$1 AND user_id=$2", [eventId, userId]);
  if (!me) throw notFound("event");
  const target = await one<{ user_id: string }>("SELECT ea.user_id FROM event_attendees ea WHERE ea.event_id=$1 AND ea.profile_id=$2 AND ea.opt_in AND ea.user_id IS NOT NULL", [eventId, input.targetProfileId]);
  if (!target) throw notFound("attendee"); // only attendees who opted into networking can receive requests
  if (target.user_id === userId) throw badRequest("self_request");
  const now = Date.now();
  if (input.slots.some((s) => new Date(s.startsAt).getTime() < now)) throw badRequest("slot_in_past", "지난 시간은 제안할 수 없습니다.");
  try {
    return await tx(async (c) => {
      const r = await one<{ id: string }>(
        "INSERT INTO event_meeting_requests (event_id, requester_user_id, target_user_id, message, location, proposed_slots) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [eventId, userId, target.user_id, input.message ?? null, input.location ?? null, JSON.stringify(input.slots)],
        c,
      );
      const name = await one<{ name: string }>("SELECT name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC LIMIT 1", [userId], c);
      await notify(c, target.user_id, { kind: "event.meeting.requested", title: "행사 1:1 미팅 요청", body: `${name?.name ?? "참가자"}님이 미팅을 요청했어요.`, url: `/app/events/${eventId}`, dedupeKey: `emr:${r!.id}` });
      await audit(c, ctx, "event.meeting.requested", "event", eventId, { request: r!.id });
      return { id: r!.id, status: "pending" };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("request_pending", "이미 대기 중인 요청이 있습니다.");
    throw e;
  }
}

export async function listEventMeetingRequests(ctx: Ctx, eventId: string) {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<any>(
    `SELECT r.*, rp.name AS requester_name, rp.company AS requester_company, tp.name AS target_name, tp.company AS target_company
     FROM event_meeting_requests r
     LEFT JOIN LATERAL (SELECT name, company FROM profiles WHERE user_id=r.requester_user_id ORDER BY is_primary DESC LIMIT 1) rp ON true
     LEFT JOIN LATERAL (SELECT name, company FROM profiles WHERE user_id=r.target_user_id ORDER BY is_primary DESC LIMIT 1) tp ON true
     WHERE r.event_id=$1 AND (r.requester_user_id=$2 OR r.target_user_id=$2) ORDER BY r.created_at DESC LIMIT 100`,
    [eventId, ctx.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    direction: r.target_user_id === ctx.userId ? "incoming" : "outgoing",
    counterpart: r.target_user_id === ctx.userId ? { name: r.requester_name, company: r.requester_company } : { name: r.target_name, company: r.target_company },
    message: r.message,
    location: r.location,
    slots: r.proposed_slots,
    status: r.status,
    accepted: r.accepted_start ? { startsAt: r.accepted_start, endsAt: r.accepted_end } : null,
    createdAt: r.created_at,
  }));
}

export const eventMeetingResponse = z.object({ accept: z.boolean(), slotIndex: z.number().int().min(0).max(2).default(0) });

/** Target accepts (choosing one proposed slot) or declines. Acceptance creates an approved candidate for both people. */
export async function respondEventMeeting(ctx: Ctx, requestId: string, input: z.infer<typeof eventMeetingResponse>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const accounts = await tx(async (c) => {
    const r = await one<any>("SELECT r.*, e.name AS event_name, e.venue FROM event_meeting_requests r JOIN events e ON e.id=r.event_id WHERE r.id=$1 AND r.target_user_id=$2 FOR UPDATE OF r", [requestId, userId], c);
    if (!r) throw notFound("request");
    if (r.status !== "pending") throw conflict("request_closed", "이미 처리된 요청입니다.");
    if (!input.accept) {
      await c.query("UPDATE event_meeting_requests SET status='declined', decided_at=now() WHERE id=$1", [requestId]);
      await notify(c, r.requester_user_id, { kind: "event.meeting.declined", title: "미팅 요청이 거절되었어요", body: r.event_name, url: `/app/events/${r.event_id}`, dedupeKey: `emr-d:${requestId}` });
      await audit(c, ctx, "event.meeting.declined", "event", r.event_id, { request: requestId });
      return [];
    }
    const slot = (r.proposed_slots as { startsAt: string; endsAt: string }[])[input.slotIndex];
    if (!slot) throw badRequest("invalid_slot");
    await c.query("UPDATE event_meeting_requests SET status='accepted', accepted_start=$2, accepted_end=$3, decided_at=now() WHERE id=$1", [requestId, slot.startsAt, slot.endsAt]);
    const names = await q<{ user_id: string; name: string }>("SELECT DISTINCT ON (user_id) user_id, name FROM profiles WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, is_primary DESC", [[r.requester_user_id, r.target_user_id]], c);
    const nameOf = (u: string) => names.find((n) => n.user_id === u)?.name ?? "참가자";
    const out: { id: string; provider: string }[] = [];
    for (const [owner, other] of [[r.requester_user_id, r.target_user_id], [r.target_user_id, r.requester_user_id]] as [string, string][]) {
      // attendees stay empty: the counterpart's email is not disclosed through the calendar invite
      const cand = await insertCandidate(c, owner, { source: "event_request", event_id: r.event_id, title: `${nameOf(other)}님과 1:1 · ${r.event_name}`, location: r.location ?? r.venue ?? null, starts_at: new Date(slot.startsAt), ends_at: new Date(slot.endsAt), status: "approved", note: r.message ?? null });
      await c.query("UPDATE calendar_candidates SET decided_at=now() WHERE id=$1", [cand.id]);
      const acct = await enqueueCalendarJob(c, owner, cand.id, 1, "upsert", false);
      if (acct) out.push(acct);
    }
    await notify(c, r.requester_user_id, { kind: "event.meeting.accepted", title: "미팅 요청이 수락되었어요", body: `${r.event_name} · ${slot.startsAt.slice(0, 16).replace("T", " ")} UTC`, url: `/app/events/${r.event_id}`, dedupeKey: `emr-a:${requestId}` });
    await audit(c, ctx, "event.meeting.accepted", "event", r.event_id, { request: requestId });
    return out;
  });
  for (const a of accounts) await processSyncJobs(20, a.id).catch(() => 0);
  return { id: requestId, status: input.accept ? "accepted" : "declined" };
}

export async function cancelEventMeetingRequest(ctx: Ctx, requestId: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("UPDATE event_meeting_requests SET status='cancelled', decided_at=now() WHERE id=$1 AND requester_user_id=$2 AND status='pending' RETURNING id", [requestId, ctx.userId]);
  if (!r) throw notFound("request");
  return { id: requestId, status: "cancelled" };
}

export async function calendarStatus(userId: string) {
  const acct = await calendarAccount(userId);
  return { provider: acct?.provider ?? null, icsFallback: true };
}
