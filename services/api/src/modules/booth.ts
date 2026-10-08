// booth module — F-147 부스 Lead Flow (빠른 캡처, BANT 자격 태그/점수, 메모, 팀 배정, CSV), F-149 Event ROI, F-151 주최자 API
// Team = event owner + attendees with metadata.role in (organizer, staff). Organizer API uses per-event bearer tokens (hash only in DB).
import { LEAD_QUALIFIERS, eventRoi, generateToken, scoreLead, toCsv } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, rateLimit, sha256 } from "../lib/platform";
import { notify } from "./inbox";
import { insertContact } from "./relationship";

async function teamRole(eventId: string, userId: string, db: Db = pool()): Promise<"owner" | "staff" | null> {
  const r = await one<{ owner: boolean; role: string | null }>(
    `SELECT e.owner_user_id = $2 AS owner, ea.metadata->>'role' AS role FROM events e
     LEFT JOIN event_attendees ea ON ea.event_id = e.id AND ea.user_id = $2 WHERE e.id = $1 LIMIT 1`,
    [eventId, userId],
    db,
  );
  if (!r) throw notFound("event");
  if (r.owner) return "owner";
  return r.role === "organizer" || r.role === "staff" ? "staff" : null;
}

async function requireTeam(ctx: Ctx, eventId: string, db: Db = pool()) {
  if (!ctx.userId) throw unauthorized();
  const role = await teamRole(eventId, ctx.userId, db);
  if (!role) throw forbidden("부스 팀만 리드를 볼 수 있습니다.");
  return { userId: ctx.userId, role };
}

async function requireOwner(ctx: Ctx, eventId: string) {
  const t = await requireTeam(ctx, eventId);
  if (t.role !== "owner") throw forbidden("행사 소유자만 할 수 있습니다.");
  return t.userId;
}

/** POST /events/{id}/staff — owner adds/removes a booth staff member (must already be an attendee). */
export async function setStaff(ctx: Ctx, eventId: string, userId: string, staff: boolean) {
  await requireOwner(ctx, eventId);
  const r = await one<{ id: string }>(
    `UPDATE event_attendees SET metadata = jsonb_set(COALESCE(metadata,'{}'), '{role}', to_jsonb($3::text)) WHERE event_id=$1 AND user_id=$2 RETURNING id`,
    [eventId, userId, staff ? "staff" : "attendee"],
  );
  if (!r) throw notFound("attendee");
  await audit(pool(), ctx, staff ? "event.staff_added" : "event.staff_removed", "event", eventId, { user: userId });
  return { userId, role: staff ? "staff" : "attendee" };
}

export async function listTeam(ctx: Ctx, eventId: string) {
  await requireTeam(ctx, eventId);
  return q<{ user_id: string; name: string | null; role: string }>(
    `SELECT e.owner_user_id AS user_id, u.display_name AS name, 'owner' AS role FROM events e JOIN users u ON u.id=e.owner_user_id WHERE e.id=$1
     UNION SELECT ea.user_id, u.display_name, ea.metadata->>'role' FROM event_attendees ea JOIN users u ON u.id=ea.user_id
     WHERE ea.event_id=$1 AND ea.metadata->>'role' = 'staff'`,
    [eventId],
  );
}

export const eventSettingsInput = z.object({
  costCents: z.number().int().min(0).max(10_000_000_000).optional(),
  audience: z.enum(["investor", "customer", "partner", "recruiting", "general"]).nullish(),
});

/** PATCH /events/{id}/settings — event cost (ROI) and default audience variant (F-031). */
export async function updateEventSettings(ctx: Ctx, eventId: string, input: z.infer<typeof eventSettingsInput>) {
  await requireOwner(ctx, eventId);
  await q("UPDATE events SET cost_cents = COALESCE($2, cost_cents), audience = CASE WHEN $4 THEN $3 ELSE audience END WHERE id=$1", [
    eventId,
    input.costCents ?? null,
    input.audience ?? null,
    input.audience !== undefined,
  ]);
  await audit(pool(), ctx, "event.settings_updated", "event", eventId, { cost: input.costCents !== undefined, audience: input.audience ?? null });
  return one("SELECT id, cost_cents, audience FROM events WHERE id=$1", [eventId]);
}

// ---------- F-147 lead flow ----------
const qualifiers = z.array(z.enum(LEAD_QUALIFIERS)).max(4).default([]);
export const leadInput = z
  .object({
    contactId: z.string().uuid().optional(),
    contact: z
      .object({
        fullName: z.string().trim().min(1).max(120),
        company: z.string().trim().max(160).nullish(),
        jobTitle: z.string().trim().max(160).nullish(),
        email: z.string().trim().max(200).nullish(),
        phone: z.string().trim().max(60).nullish(),
      })
      .optional(),
    qualifiers,
    tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    interest: z.enum(["hot", "warm", "cold"]).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    assignedTo: z.string().uuid().nullish(),
  })
  .refine((v) => !!v.contactId !== !!v.contact, "contactId 또는 contact 중 하나만 보내세요.");

export const leadPatch = z.object({
  qualifiers: qualifiers.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  interest: z.enum(["hot", "warm", "cold"]).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  assignedTo: z.string().uuid().nullish(),
  stage: z.enum(["new", "contacted", "meeting", "proposal", "won", "lost"]).optional(),
  dealValueCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
});

async function assertAssignable(c: Db, eventId: string, userId: string | null | undefined) {
  if (!userId) return;
  if (!(await teamRole(eventId, userId, c))) throw badRequest("assignee_not_in_team", "부스 팀원에게만 배정할 수 있습니다.");
}

async function rescore(c: Db, leadId: string) {
  const l = await one<{ qualifiers: string[]; interest: "hot" | "warm" | "cold" | null; notes: string | null; email: string | null; phone: string | null }>(
    "SELECT l.qualifiers, l.interest, l.notes, ct.email, ct.phone FROM event_leads l JOIN contacts ct ON ct.id=l.contact_id WHERE l.id=$1",
    [leadId],
    c,
  );
  if (!l) return;
  const s = scoreLead({ qualifiers: l.qualifiers, interest: l.interest, hasEmail: !!l.email, hasPhone: !!l.phone, hasNotes: !!l.notes });
  await c.query("UPDATE event_leads SET score=$2, grade=$3, updated_at=now() WHERE id=$1", [leadId, s.score, s.grade]);
}

/** POST /events/{id}/leads — booth fast capture (new contact or an existing one) + qualification. */
export async function captureLead(ctx: Ctx, eventId: string, input: z.infer<typeof leadInput>) {
  return tx(async (c) => {
    const { userId } = await requireTeam(ctx, eventId, c);
    await assertAssignable(c, eventId, input.assignedTo);
    let contactId: string;
    if (input.contact) {
      const prov = Object.fromEntries(Object.keys(input.contact).map((k) => [k, { source: "user" }]));
      const ids = await insertContact(c, userId, { ...input.contact, source: "event", provenance: prov, encounter: { eventId, placeLabel: "부스" } });
      contactId = ids.contactId;
    } else {
      const own = await one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [input.contactId, userId], c);
      if (!own) throw notFound("contact");
      contactId = own.id;
      const hasEnc = await one("SELECT 1 FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 AND event_id=$3", [userId, contactId, eventId], c);
      if (!hasEnc) await c.query("INSERT INTO encounters (owner_user_id, contact_id, event_id, source, place_label) VALUES ($1,$2,$3,'event','부스')", [userId, contactId, eventId]);
    }
    const lead = await one<{ id: string }>(
      `INSERT INTO event_leads (event_id, contact_id, captured_by, assigned_to, qualifiers, tags, interest, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id, contact_id) DO UPDATE SET qualifiers=EXCLUDED.qualifiers, tags=EXCLUDED.tags, interest=EXCLUDED.interest,
         notes=COALESCE(EXCLUDED.notes, event_leads.notes), assigned_to=COALESCE(EXCLUDED.assigned_to, event_leads.assigned_to), updated_at=now()
       RETURNING id`,
      [eventId, contactId, userId, input.assignedTo ?? null, input.qualifiers, input.tags, input.interest ?? null, input.notes ?? null],
      c,
    );
    await rescore(c, lead!.id);
    if (input.assignedTo && input.assignedTo !== userId) {
      await notify(c, input.assignedTo, { kind: "lead_assigned", title: "새 부스 리드가 배정됐어요", link: `/app/events/${eventId}/booth`, data: { leadId: lead!.id, eventId }, dedupeKey: `lead:${lead!.id}` });
    }
    await audit(c, ctx, "event.lead_captured", "event", eventId, { lead: lead!.id });
    return getLead(c, lead!.id);
  });
}

async function getLead(db: Db, id: string) {
  return one<any>(
    `SELECT l.id, l.event_id, l.contact_id, ct.full_name, co.name AS company, ct.job_title, l.captured_by, l.assigned_to, au.display_name AS assignee_name,
       l.qualifiers, l.tags, l.interest, l.score, l.grade, l.notes, l.stage, l.deal_value_cents, l.created_at, l.updated_at
     FROM event_leads l JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN companies co ON co.id=ct.company_id LEFT JOIN users au ON au.id=l.assigned_to WHERE l.id=$1`,
    [id],
    db,
  );
}

export async function updateLead(ctx: Ctx, leadId: string, patch: z.infer<typeof leadPatch>) {
  return tx(async (c) => {
    const l = await one<{ id: string; event_id: string }>("SELECT id, event_id FROM event_leads WHERE id=$1 FOR UPDATE", [leadId], c);
    if (!l) throw notFound("lead");
    const { userId } = await requireTeam(ctx, l.event_id, c);
    if (patch.assignedTo !== undefined) await assertAssignable(c, l.event_id, patch.assignedTo);
    const sets: string[] = [];
    const params: unknown[] = [leadId];
    const put = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col}=$${params.length}`);
    };
    if (patch.qualifiers) put("qualifiers", patch.qualifiers);
    if (patch.tags) put("tags", patch.tags);
    if (patch.interest !== undefined) put("interest", patch.interest);
    if (patch.notes !== undefined) put("notes", patch.notes);
    if (patch.assignedTo !== undefined) put("assigned_to", patch.assignedTo);
    if (patch.stage) put("stage", patch.stage);
    if (patch.dealValueCents !== undefined) put("deal_value_cents", patch.dealValueCents);
    if (sets.length) await c.query(`UPDATE event_leads SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, params);
    await rescore(c, leadId);
    if (patch.assignedTo && patch.assignedTo !== userId) {
      await notify(c, patch.assignedTo, { kind: "lead_assigned", title: "부스 리드가 배정됐어요", link: `/app/events/${l.event_id}/booth`, data: { leadId, eventId: l.event_id }, dedupeKey: `lead:${leadId}` });
    }
    await audit(c, ctx, "event.lead_updated", "event", l.event_id, { lead: leadId, fields: Object.keys(patch) });
    return getLead(c, leadId);
  });
}

export async function listLeads(ctx: Ctx, eventId: string, opts: { mine?: boolean; grade?: string } = {}) {
  const { userId } = await requireTeam(ctx, eventId);
  const params: unknown[] = [eventId];
  let where = "l.event_id=$1";
  if (opts.mine) {
    params.push(userId);
    where += ` AND l.assigned_to=$${params.length}`;
  }
  if (opts.grade) {
    params.push(opts.grade);
    where += ` AND l.grade=$${params.length}`;
  }
  return q<any>(
    `SELECT l.id, l.contact_id, ct.full_name, co.name AS company, ct.job_title, l.assigned_to, au.display_name AS assignee_name, l.qualifiers, l.tags,
       l.interest, l.score, l.grade, l.notes, l.stage, l.deal_value_cents, l.created_at
     FROM event_leads l JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN companies co ON co.id=ct.company_id LEFT JOIN users au ON au.id=l.assigned_to
     WHERE ${where} ORDER BY l.score DESC, l.created_at DESC LIMIT 1000`,
    params,
  );
}

const CSV_COLUMNS = ["full_name", "company", "job_title", "email", "phone", "grade", "score", "qualifiers", "tags", "interest", "stage", "deal_value", "assignee", "notes", "captured_at"];

async function leadExportRows(eventId: string) {
  const rows = await q<any>(
    `SELECT ct.full_name, co.name AS company, ct.job_title, ct.email, ct.phone, l.grade, l.score, l.qualifiers, l.tags, l.interest, l.stage,
       l.deal_value_cents, au.display_name AS assignee, l.notes, l.created_at
     FROM event_leads l JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN companies co ON co.id=ct.company_id LEFT JOIN users au ON au.id=l.assigned_to
     WHERE l.event_id=$1 ORDER BY l.created_at`,
    [eventId],
  );
  return rows.map((r) => ({
    ...r,
    qualifiers: (r.qualifiers ?? []).join("|"),
    tags: (r.tags ?? []).join("|"),
    deal_value: (Number(r.deal_value_cents) / 100).toFixed(2),
    captured_at: new Date(r.created_at).toISOString(),
  }));
}

/** GET /events/{id}/leads.csv — audited export (PII leaves the system). */
export async function exportLeadsCsv(ctx: Ctx, eventId: string) {
  await requireTeam(ctx, eventId);
  await rateLimit(`leads-export:${ctx.userId}`, 30, 3600);
  const rows = await leadExportRows(eventId);
  await audit(pool(), ctx, "event.leads_exported", "event", eventId, { count: rows.length, format: "csv" });
  return { filename: `leads-${eventId.slice(0, 8)}.csv`, body: toCsv(rows, CSV_COLUMNS) };
}

// ---------- F-149 Event ROI ----------
export async function eventRoiReport(ctx: Ctx, eventId: string) {
  await requireTeam(ctx, eventId);
  const r = await one<any>(
    `WITH leads AS (SELECT l.* FROM event_leads l WHERE l.event_id=$1)
     SELECT
       (SELECT count(*)::int FROM leads) AS leads,
       (SELECT count(*)::int FROM leads WHERE grade IN ('A','B')) AS qualified,
       (SELECT count(DISTINCT m.id)::int FROM leads l JOIN meeting_participants mp ON mp.contact_id=l.contact_id JOIN meetings m ON m.id=mp.meeting_id
          WHERE m.created_at >= l.created_at) AS meetings,
       (SELECT count(*)::int FROM leads l JOIN followups f ON f.contact_id=l.contact_id AND f.created_at >= l.created_at - interval '1 day') AS followups_total,
       (SELECT count(*)::int FROM leads l JOIN followups f ON f.contact_id=l.contact_id AND f.created_at >= l.created_at - interval '1 day' AND f.status='done') AS followups_done,
       (SELECT COALESCE(sum(deal_value_cents),0)::bigint FROM leads WHERE stage NOT IN ('won','lost')) AS pipeline,
       (SELECT COALESCE(sum(deal_value_cents),0)::bigint FROM leads WHERE stage='won') AS won,
       (SELECT cost_cents FROM events WHERE id=$1) AS cost,
       (SELECT count(*)::int FROM encounters en WHERE en.event_id=$1) AS encounters`,
    [eventId],
  );
  const stages = await q<{ stage: string; n: number }>("SELECT stage, count(*)::int AS n FROM event_leads WHERE event_id=$1 GROUP BY stage", [eventId]);
  return {
    eventId,
    encounters: r.encounters,
    stages,
    ...eventRoi({
      leads: r.leads,
      qualifiedLeads: r.qualified,
      meetingsBooked: r.meetings,
      followupsTotal: r.followups_total,
      followupsDone: r.followups_done,
      costCents: Number(r.cost ?? 0),
      pipelineCents: Number(r.pipeline),
      wonCents: Number(r.won),
    }),
  };
}

// ---------- F-151 organizer API ----------
export const ORGANIZER_SCOPES = ["attendees:read", "leads:read"] as const;
export const tokenInput = z.object({ label: z.string().trim().min(1).max(80), scopes: z.array(z.enum(ORGANIZER_SCOPES)).min(1).default(["attendees:read", "leads:read"]) });

export async function createOrganizerToken(ctx: Ctx, eventId: string, input: z.infer<typeof tokenInput>) {
  const uid = await requireOwner(ctx, eventId);
  const token = `lkev_${generateToken()}`;
  const r = await one<{ id: string; created_at: Date }>(
    "INSERT INTO event_api_tokens (event_id, token_hash, label, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at",
    [eventId, sha256(token), input.label, input.scopes, uid],
  );
  await audit(pool(), ctx, "event.api_token_created", "event", eventId, { tokenId: r!.id, scopes: input.scopes });
  // shown once; only the hash is stored
  return { id: r!.id, token, label: input.label, scopes: input.scopes, createdAt: r!.created_at };
}

export async function listOrganizerTokens(ctx: Ctx, eventId: string) {
  await requireOwner(ctx, eventId);
  return q<any>("SELECT id, label, scopes, created_at, last_used_at, revoked_at FROM event_api_tokens WHERE event_id=$1 ORDER BY created_at DESC", [eventId]);
}

export async function revokeOrganizerToken(ctx: Ctx, eventId: string, tokenId: string) {
  await requireOwner(ctx, eventId);
  const r = await one("UPDATE event_api_tokens SET revoked_at=now() WHERE id=$1 AND event_id=$2 AND revoked_at IS NULL RETURNING id", [tokenId, eventId]);
  if (!r) throw notFound("token");
  await audit(pool(), ctx, "event.api_token_revoked", "event", eventId, { tokenId });
  return { revoked: true };
}

/** Authenticate `Authorization: Bearer lkev_…` for one event + scope. */
export async function authenticateOrganizer(authorization: string | null, eventId: string, scope: (typeof ORGANIZER_SCOPES)[number]) {
  const m = /^Bearer\s+(lkev_[A-Za-z0-9_-]{20,})$/.exec(authorization?.trim() ?? "");
  if (!m) throw new ApiError(401, "invalid_token", "유효한 행사 API 토큰이 필요합니다.");
  const t = await one<{ id: string; event_id: string; scopes: string[]; last_used_at: Date | null }>(
    "SELECT id, event_id, scopes, last_used_at FROM event_api_tokens WHERE token_hash=$1 AND revoked_at IS NULL",
    [sha256(m[1]!)],
  );
  if (!t || t.event_id !== eventId) throw new ApiError(401, "invalid_token", "유효한 행사 API 토큰이 필요합니다.");
  if (!t.scopes.includes(scope)) throw forbidden("이 토큰에는 해당 권한이 없습니다.");
  await rateLimit(`organizer:${t.id}`, 600, 3600);
  if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 60_000) await q("UPDATE event_api_tokens SET last_used_at=now() WHERE id=$1", [t.id]);
  return t;
}

/** Attendees who opted in to sharing — public card fields only (never email/phone unless marked public by the attendee). */
export async function organizerAttendees(authorization: string | null, eventId: string, opts: { limit?: number; after?: string } = {}) {
  const t = await authenticateOrganizer(authorization, eventId, "attendees:read");
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const rows = await q<any>(
    `SELECT ea.id AS attendee_id, p.slug, p.name, p.company, p.job_title, p.headline, ea.created_at AS joined_at,
       COALESCE((SELECT json_agg(json_build_object('type', f.field_type, 'value', f.value) ORDER BY f.sort_order)
         FROM profile_fields f WHERE f.profile_id = p.id AND f.visibility = 'public'), '[]'::json) AS public_fields
     FROM event_attendees ea JOIN profiles p ON p.id = ea.profile_id
     WHERE ea.event_id=$1 AND ea.opt_in AND ($2::uuid IS NULL OR ea.id > $2::uuid) ORDER BY ea.id LIMIT $3`,
    [eventId, opts.after ?? null, limit],
  );
  await audit(pool(), { userId: null }, "organizer_api.attendees_read", "event", eventId, { tokenId: t.id, count: rows.length });
  return {
    data: rows.map((r) => ({
      attendeeId: r.attendee_id,
      name: r.name,
      company: r.company,
      jobTitle: r.job_title,
      headline: r.headline,
      cardUrl: `/p/${r.slug}`,
      publicFields: (r.public_fields as { type: string; value: unknown }[]).map((f) => ({ type: f.type, value: typeof f.value === "string" ? f.value : String((f.value as { v?: unknown })?.v ?? f.value) })),
      joinedAt: r.joined_at,
    })),
    next: rows.length === limit ? rows[rows.length - 1].attendee_id : null,
  };
}

/** The event team's own booth leads (JSON or CSV), audited per call. */
export async function organizerLeads(authorization: string | null, eventId: string, format: "json" | "csv" = "json") {
  const t = await authenticateOrganizer(authorization, eventId, "leads:read");
  const rows = await leadExportRows(eventId);
  await audit(pool(), { userId: null }, "organizer_api.leads_exported", "event", eventId, { tokenId: t.id, count: rows.length, format });
  if (format === "csv") return { csv: toCsv(rows, CSV_COLUMNS) };
  return { data: rows.map(({ deal_value_cents: _d, created_at: _c, ...r }) => r) };
}
