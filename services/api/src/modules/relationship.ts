// relationship module — Contacts & Relationship Core: contact CRUD, encounter, relationship, timeline, notes, tags, duplicate, merge(+undo)
import { type ContactLike, type MergeableField, findDuplicates, mergeContacts, normalizeCompanyName, normalizeEmail, normalizePhone } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { type Db, allowEncounterRewrite, one, pool, q, tx } from "../lib/db";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit } from "../lib/platform";

export const contactInput = z.object({
  fullName: z.string().trim().min(1).max(120),
  company: z.string().trim().max(160).nullish(),
  jobTitle: z.string().trim().max(160).nullish(),
  department: z.string().trim().max(160).nullish(),
  email: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(60).nullish(),
  address: z.string().trim().max(400).nullish(),
  website: z.string().trim().max(300).nullish(),
  source: z.enum(["manual", "scan", "exchange", "import", "event", "claim", "google"]).default("manual"),
  provenance: z.record(z.string(), z.object({ source: z.string(), confidence: z.number().min(0).max(1).optional() })).default({}),
  businessCardId: z.string().uuid().nullish(),
  encounter: z.object({ placeLabel: z.string().max(200).optional(), note: z.string().max(2000).optional(), eventId: z.string().uuid().optional(), occurredAt: z.string().datetime().optional() }).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  version: z.number().int().optional(),
});
export type ContactInput = z.infer<typeof contactInput>;

export interface ContactRow {
  id: string;
  owner_user_id: string;
  linked_user_id: string | null;
  full_name: string;
  company: string | null;
  job_title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  source: string | null;
  field_provenance: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_contact_at?: Date | null;
  next_followup_at?: Date | null;
  tags?: string[];
}

const CONTACT_SELECT = `
  c.id, c.owner_user_id, c.linked_user_id, c.full_name, co.name AS company, c.job_title, c.department, c.email, c.phone,
  c.address, c.website, c.source, c.field_provenance, c.version, c.created_at, c.updated_at`;

export function toContactDto(r: ContactRow) {
  return {
    id: r.id,
    fullName: r.full_name,
    company: r.company,
    jobTitle: r.job_title,
    department: r.department,
    email: r.email,
    phone: r.phone,
    address: r.address,
    website: r.website,
    source: r.source,
    linkedUserId: r.linked_user_id,
    provenance: r.field_provenance,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastContactAt: r.last_contact_at ?? null,
    nextFollowupAt: r.next_followup_at ?? null,
    tags: r.tags ?? [],
  };
}
export type ContactDto = ReturnType<typeof toContactDto>;

export async function upsertCompany(db: Db, name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const normalized = normalizeCompanyName(name) || name.toLowerCase();
  const r = await one<{ id: string }>(
    `INSERT INTO companies (name, normalized_name) VALUES ($1,$2)
     ON CONFLICT (normalized_name) DO UPDATE SET name = companies.name RETURNING id`,
    [name, normalized],
    db,
  );
  return r!.id;
}

function cleanEmail(e: string | null | undefined) {
  return e ? (normalizeEmail(e) ?? e.trim()) : null;
}

/** Insert a contact + encounter + relationship in the given transaction. */
export async function insertContact(
  c: pg.PoolClient,
  ownerUserId: string,
  input: ContactInput,
  extras: { linkedUserId?: string | null; exchangeSessionId?: string | null; encounterSource?: string } = {},
): Promise<{ contactId: string; encounterId: string; relationshipId: string }> {
  const companyId = await upsertCompany(c, input.company);
  const row = await one<{ id: string }>(
    `INSERT INTO contacts (owner_user_id, linked_user_id, company_id, full_name, job_title, department, email, phone, address, website, source, field_provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ownerUserId, extras.linkedUserId ?? null, companyId, input.fullName, input.jobTitle ?? null, input.department ?? null, cleanEmail(input.email), input.phone ?? null, input.address ?? null, input.website ?? null, input.source, JSON.stringify(input.provenance ?? {})],
    c,
  );
  const contactId = row!.id;
  if (input.businessCardId) {
    await c.query("UPDATE business_cards SET contact_id=$1 WHERE id=$2 AND captured_by=$3", [contactId, input.businessCardId, ownerUserId]);
  }
  const enc = await one<{ id: string }>(
    `INSERT INTO encounters (owner_user_id, contact_id, event_id, occurred_at, source, place_label, note, exchange_session_id, context)
     VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9) RETURNING id`,
    [ownerUserId, contactId, input.encounter?.eventId ?? null, input.encounter?.occurredAt ?? null, extras.encounterSource ?? input.source, input.encounter?.placeLabel ?? null, input.encounter?.note ?? null, extras.exchangeSessionId ?? null, JSON.stringify({})],
    c,
  );
  const rel = await one<{ id: string }>(
    `INSERT INTO relationships (owner_user_id, contact_id, status, strength, last_contact_at)
     VALUES ($1,$2,'active',0.3, now())
     ON CONFLICT (owner_user_id, contact_id) DO UPDATE SET last_contact_at = now() RETURNING id`,
    [ownerUserId, contactId],
    c,
  );
  if (input.tags?.length) await setTags(c, ownerUserId, contactId, input.tags);
  await emit(c, "contact.updated", "contact", contactId, { contact_id: contactId, changed_fields: ["created"] });
  return { contactId, encounterId: enc!.id, relationshipId: rel!.id };
}

async function setTags(c: Db, ownerUserId: string, contactId: string, tags: string[]) {
  await c.query("DELETE FROM contact_tags WHERE contact_id=$1", [contactId]);
  for (const name of [...new Set(tags)]) {
    const t = await one<{ id: string }>(
      "INSERT INTO tags (owner_user_id, name) VALUES ($1,$2) ON CONFLICT (owner_user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [ownerUserId, name],
      c,
    );
    await c.query("INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [contactId, t!.id]);
  }
}

export async function createContact(ctx: Ctx, input: ContactInput) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const ids = await insertContact(c, userId, input);
    await audit(c, ctx, "contact.created", "contact", ids.contactId, { source: input.source });
    return { ...ids, contact: await getContactRow(userId, ids.contactId, c) };
  });
}

export async function getContactRow(userId: string, id: string, db: Db = pool()): Promise<ContactDto> {
  const r = await one<ContactRow>(
    `SELECT ${CONTACT_SELECT}, rel.last_contact_at, rel.next_followup_at,
       COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id), '{}') AS tags
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN relationships rel ON rel.contact_id = c.id AND rel.owner_user_id = c.owner_user_id
     WHERE c.id=$1 AND c.owner_user_id=$2 AND c.deleted_at IS NULL`,
    [id, userId],
    db,
  );
  if (!r) throw notFound("contact");
  return toContactDto(r);
}

export async function listContacts(userId: string, opts: { query?: string; tag?: string; limit?: number; cursor?: string } = {}) {
  // Plan-stable shape (stays fast even with stale statistics right after bulk imports):
  // 1) rank the owner's live contacts and keep the top N ids, joining relationships through its unique (owner, contact) index;
  // 2) attach company + tags only for those N rows.
  const params: unknown[] = [userId];
  let where = "c.owner_user_id=$1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL";
  if (opts.query) {
    params.push(`%${opts.query.replace(/[%_\\]/g, "\\$&")}%`);
    const i = params.length;
    where += ` AND (c.full_name ILIKE $${i} OR c.email ILIKE $${i} OR c.job_title ILIKE $${i} OR c.phone ILIKE $${i}
      OR EXISTS (SELECT 1 FROM companies cq WHERE cq.id = c.company_id AND cq.name ILIKE $${i}))`;
  }
  if (opts.tag) {
    params.push(opts.tag);
    where += ` AND EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=c.id AND t.owner_user_id=$1 AND t.name=$${params.length})`;
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 200)));
  const rows = await q<ContactRow>(
    `WITH top AS (
       -- correlated lookup = always a per-row probe of the unique (owner_user_id, contact_id) index;
       -- a JOIN here degrades to a 14M-row nested loop when statistics are stale (measured: 4.7s → ms)
       SELECT c.id,
         COALESCE((SELECT rel.last_contact_at FROM relationships rel WHERE rel.owner_user_id = $1 AND rel.contact_id = c.id), c.created_at) AS sort_at
       FROM contacts c
       WHERE ${where}
       ORDER BY sort_at DESC
       LIMIT $${params.length}
     )
     SELECT ${CONTACT_SELECT}, rel.last_contact_at, rel.next_followup_at,
       COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id), '{}') AS tags
     FROM top JOIN contacts c ON c.id = top.id LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN relationships rel ON rel.owner_user_id = $1 AND rel.contact_id = c.id
     ORDER BY top.sort_at DESC`,
    params,
  );
  return rows.map(toContactDto);
}

export async function updateContact(ctx: Ctx, id: string, input: Partial<ContactInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const cur = await one<ContactRow & { company_id: string | null }>("SELECT * FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE", [id, userId], c);
    if (!cur) throw notFound("contact");
    if (input.version !== undefined && input.version !== cur.version) {
      throw conflict("version_conflict", "다른 곳에서 먼저 수정되었습니다.", { serverVersion: cur.version, current: toContactDto({ ...cur, company: null }) });
    }
    const changed: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: [keyof ContactInput, string][] = [
      ["fullName", "full_name"], ["jobTitle", "job_title"], ["department", "department"], ["email", "email"], ["phone", "phone"], ["address", "address"], ["website", "website"],
    ];
    for (const [k, col] of map) {
      if (input[k] !== undefined) {
        const v = k === "email" ? cleanEmail(input[k] as string | null) : (input[k] ?? null);
        params.push(v);
        sets.push(`${col}=$${params.length}`);
        changed.push(k);
      }
    }
    if (input.company !== undefined) {
      params.push(await upsertCompany(c, input.company));
      sets.push(`company_id=$${params.length}`);
      changed.push("company");
    }
    if (changed.length) {
      // F-073 field-level history (owner-only)
      const colOf: Record<string, string> = { fullName: "full_name", jobTitle: "job_title", department: "department", email: "email", phone: "phone", address: "address", website: "website" };
      const oldCompany = cur.company_id ? (await one<{ name: string }>("SELECT name FROM companies WHERE id=$1", [cur.company_id], c))?.name ?? null : null;
      for (const k of changed) {
        const oldV = k === "company" ? oldCompany : ((cur as unknown as Record<string, string | null>)[colOf[k]!] ?? null);
        const newV = k === "company" ? (input.company ?? null) : k === "email" ? cleanEmail(input.email) : ((input as Record<string, string | null | undefined>)[k] ?? null);
        if ((oldV ?? "") !== (newV ?? "")) {
          await c.query("INSERT INTO contact_field_history (contact_id, owner_user_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)", [id, userId, k, oldV, newV]);
        }
      }
      const prov = { ...(cur.field_provenance as Record<string, unknown>) };
      for (const k of changed) prov[k] = { source: "user" };
      params.push(JSON.stringify(prov));
      sets.push(`field_provenance=$${params.length}`);
      await c.query(`UPDATE contacts SET ${sets.join(", ")}, version = version + 1, updated_at = now() WHERE id=$1`, params);
      await emit(c, "contact.updated", "contact", id, { contact_id: id, changed_fields: changed });
    }
    if (input.tags) await setTags(c, userId, id, input.tags);
    await audit(c, ctx, "contact.updated", "contact", id, { fields: changed });
    return getContactRow(userId, id, c);
  });
}

export async function deleteContact(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one("UPDATE contacts SET deleted_at = now() WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL RETURNING id", [id, ctx.userId]);
  if (!r) throw notFound("contact");
  await audit(pool(), ctx, "contact.deleted", "contact", id);
}

export async function duplicatesFor(userId: string, candidate: ContactLike, excludeId?: string) {
  const existing = await listContacts(userId, { limit: 200 });
  // narrow with exact lookups first so large books still find email/phone matches
  const extra: ContactDto[] = [];
  if (candidate.email) {
    const rows = await q<ContactRow>(`SELECT ${CONTACT_SELECT} FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE c.owner_user_id=$1 AND lower(c.email)=lower($2) AND c.deleted_at IS NULL AND c.merged_into_id IS NULL`, [userId, candidate.email]);
    extra.push(...rows.map(toContactDto));
  }
  const pool_ = [...new Map([...existing, ...extra].map((c) => [c.id, c])).values()].filter((c) => c.id !== excludeId);
  return findDuplicates(candidate, pool_).slice(0, 5);
}

export async function contactTimeline(userId: string, id: string) {
  const contact = await getContactRow(userId, id);
  const [encounters, notes, cards, meetings, followups, actions] = await Promise.all([
    q<any>(`SELECT e.id, e.occurred_at, e.source, e.place_label, e.note, ev.name AS event_name FROM encounters e LEFT JOIN events ev ON ev.id = e.event_id WHERE e.owner_user_id=$1 AND e.contact_id=$2 ORDER BY e.occurred_at DESC`, [userId, id]),
    q<any>("SELECT id, body, kind, scope, created_at FROM notes WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY created_at DESC", [userId, id]),
    q<any>("SELECT id, structured_data, confidence, captured_at, source FROM business_cards WHERE captured_by=$1 AND contact_id=$2 ORDER BY captured_at DESC", [userId, id]),
    q<any>(`SELECT m.id, m.title, m.started_at, m.purpose, m.summary FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id WHERE m.owner_user_id=$1 AND mp.contact_id=$2 ORDER BY COALESCE(m.started_at, m.created_at) DESC`, [userId, id]),
    q<any>("SELECT id, kind, title, body_draft, due_at, status, source FROM followups WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY COALESCE(due_at, created_at) DESC", [userId, id]),
    q<any>("SELECT a.id, a.description, a.due_at, a.status, a.meeting_id FROM action_items a WHERE a.owner_user_id=$1 AND a.contact_id=$2 ORDER BY a.due_at NULLS LAST", [userId, id]),
  ]);
  let linkedProfile: { id: string; slug: string; name: string } | null = null;
  if (contact.linkedUserId) {
    linkedProfile = await one<{ id: string; slug: string; name: string }>("SELECT id, slug, name FROM profiles WHERE user_id=$1 ORDER BY is_primary DESC LIMIT 1", [contact.linkedUserId]);
  }
  const history = await q<any>("SELECT field, old_value, new_value, source, changed_at FROM contact_field_history WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY changed_at DESC LIMIT 50", [userId, id]);
  return { contact, encounters, notes, cards, meetings, followups, actions, linkedProfile, history };
}

export async function addNote(ctx: Ctx, contactId: string, body: string, kind: "text" | "voice" = "text") {
  if (!ctx.userId) throw unauthorized();
  await getContactRow(ctx.userId, contactId);
  // notes are always private to the owner (백서 12: 개인 메모는 상대에게 절대 노출되지 않는다)
  const r = await one<{ id: string; created_at: Date }>(
    "INSERT INTO notes (owner_user_id, contact_id, scope, body, kind) VALUES ($1,$2,'private',$3,$4) RETURNING id, created_at",
    [ctx.userId, contactId, body, kind],
  );
  return { id: r!.id, body, kind, scope: "private", createdAt: r!.created_at };
}

export async function addEncounter(ctx: Ctx, contactId: string, data: { placeLabel?: string; note?: string; occurredAt?: string; eventId?: string }) {
  if (!ctx.userId) throw unauthorized();
  await getContactRow(ctx.userId, contactId);
  const r = await one<{ id: string }>(
    `INSERT INTO encounters (owner_user_id, contact_id, event_id, occurred_at, source, place_label, note) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),'manual',$5,$6) RETURNING id`,
    [ctx.userId, contactId, data.eventId ?? null, data.occurredAt ?? null, data.placeLabel ?? null, data.note ?? null],
  );
  await q("UPDATE relationships SET last_contact_at = GREATEST(COALESCE(last_contact_at, 'epoch'), COALESCE($3::timestamptz, now())) WHERE owner_user_id=$1 AND contact_id=$2", [ctx.userId, contactId, data.occurredAt ?? null]);
  return { id: r!.id };
}

/** F-021 정보 병합: 필드별 선택, secondary 는 soft-merge(merged_into_id) 되어 undo 가능. */
export async function mergeContact(ctx: Ctx, primaryId: string, secondaryId: string, choices: Partial<Record<MergeableField, "primary" | "secondary">>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  // merging a contact into itself would set merged_into_id = id and hide it from every list
  if (primaryId === secondaryId) throw badRequest("same_contact", "같은 연락처끼리는 병합할 수 없습니다.");
  return tx(async (c) => {
    const p = await getContactRow(userId, primaryId, c);
    const s = await getContactRow(userId, secondaryId, c);
    const merged = mergeContacts(p, s, choices);
    const snapshot = { primary: p, secondary: s };
    const companyId = await upsertCompany(c, merged.company);
    await c.query(
      `UPDATE contacts SET full_name=$2, company_id=$3, job_title=$4, department=$5, email=$6, phone=$7, address=$8, website=$9,
        metadata = jsonb_set(metadata, '{merge_undo}', $10::jsonb), version=version+1, updated_at=now() WHERE id=$1`,
      [primaryId, merged.fullName, companyId, merged.jobTitle, merged.department, merged.email, merged.phone, merged.address, merged.website, JSON.stringify(snapshot)],
    );
    await c.query("UPDATE contacts SET merged_into_id=$1, updated_at=now() WHERE id=$2", [primaryId, secondaryId]);
    // §9: encounters stay append-only; a duplicate merge is the one sanctioned contact_id re-point (DB trigger opt-in)
    await allowEncounterRewrite(c, "relink");
    for (const t of ["encounters", "notes", "followups"]) await c.query(`UPDATE ${t} SET contact_id=$1 WHERE contact_id=$2`, [primaryId, secondaryId]);
    await c.query("UPDATE business_cards SET contact_id=$1 WHERE contact_id=$2", [primaryId, secondaryId]);
    await c.query("UPDATE action_items SET contact_id=$1 WHERE contact_id=$2", [primaryId, secondaryId]);
    await c.query("INSERT INTO meeting_participants (meeting_id, contact_id, role) SELECT meeting_id, $1, role FROM meeting_participants WHERE contact_id=$2 ON CONFLICT DO NOTHING", [primaryId, secondaryId]);
    await c.query("INSERT INTO contact_tags (contact_id, tag_id) SELECT $1, tag_id FROM contact_tags WHERE contact_id=$2 ON CONFLICT DO NOTHING", [primaryId, secondaryId]);
    await emit(c, "contact.updated", "contact", primaryId, { contact_id: primaryId, changed_fields: ["merged"] });
    await audit(c, ctx, "contact.merged", "contact", primaryId, { secondary: secondaryId });
    return getContactRow(userId, primaryId, c);
  });
}

export async function undoMerge(ctx: Ctx, primaryId: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  return tx(async (c) => {
    const row = await one<{ metadata: any }>("SELECT metadata FROM contacts WHERE id=$1 AND owner_user_id=$2", [primaryId, userId], c);
    const snap = row?.metadata?.merge_undo;
    if (!snap) throw notFound("merge snapshot");
    const p = snap.primary as ContactDto;
    const s = snap.secondary as ContactDto;
    await c.query(
      `UPDATE contacts SET full_name=$2, company_id=$3, job_title=$4, department=$5, email=$6, phone=$7, address=$8, website=$9, metadata = metadata - 'merge_undo', version=version+1, updated_at=now() WHERE id=$1`,
      [primaryId, p.fullName, await upsertCompany(c, p.company), p.jobTitle, p.department, p.email, p.phone, p.address, p.website],
    );
    await c.query("UPDATE contacts SET merged_into_id=NULL, updated_at=now() WHERE id=$1", [s.id]);
    await audit(c, ctx, "contact.merge_undone", "contact", primaryId, { secondary: s.id });
    return { primary: await getContactRow(userId, primaryId, c), secondary: await getContactRow(userId, s.id, c) };
  });
}

export { normalizePhone };
