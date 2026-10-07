// X-005 "만나기 전 30초 브리핑" + X-006 weekly re-connect digest (+ assistant preferences).
// Both only restate the owner's own records; AI-inferred lines are labelled; nothing is ever sent to a contact
// (re-connect messages are saved as drafts — CLAUDE.md rule 8).
import {
  type CoolingCandidate,
  type PrepBrief,
  composePrepBrief,
  pickReconnectDigest,
  prepBriefNotificationBody,
  reconnectDraft,
  weekStart,
} from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { sendMail } from "../lib/mail";
import { type Ctx, appOrigin, audit, log } from "../lib/platform";
import { loadProfile, primaryProfileId } from "./card";
import { createMessage } from "./comms";
import { coolingRelationships } from "./network";
import { notify } from "./push";

// ---------------------------------------------------------------- preferences

export const prefsInput = z.object({
  prepBriefLeadMin: z.number().int().min(0).max(240).optional(),
  reconnectDigest: z.boolean().optional(),
  reconnectEmail: z.boolean().optional(),
});

export async function getPrefs(userId: string, db: Db = pool()) {
  const r = await one<{ prep_brief_lead_min: number; reconnect_digest: boolean; reconnect_email: boolean }>(
    "SELECT prep_brief_lead_min, reconnect_digest, reconnect_email FROM user_assistant_prefs WHERE user_id=$1",
    [userId],
    db,
  );
  return { prepBriefLeadMin: r?.prep_brief_lead_min ?? 30, reconnectDigest: r?.reconnect_digest ?? true, reconnectEmail: r?.reconnect_email ?? false };
}

export async function setPrefs(ctx: Ctx, input: z.infer<typeof prefsInput>) {
  if (!ctx.userId) throw unauthorized();
  const cur = await getPrefs(ctx.userId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  await pool().query(
    `INSERT INTO user_assistant_prefs (user_id, prep_brief_lead_min, reconnect_digest, reconnect_email) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET prep_brief_lead_min=$2, reconnect_digest=$3, reconnect_email=$4, updated_at=now()`,
    [ctx.userId, next.prepBriefLeadMin, next.reconnectDigest, next.reconnectEmail],
  );
  await audit(pool(), ctx, "assistant.prefs_updated", "user", ctx.userId, next);
  return next;
}

// ---------------------------------------------------------------- X-005 prep brief

interface CandidateRow {
  id: string;
  owner_user_id: string;
  title: string;
  starts_at: Date;
  location: string | null;
  contact_id: string | null;
  meeting_id: string | null;
  attendees: { email?: string }[] | null;
}

/** A calendar entry's "known contact": its contact, else the meeting's first participant, else an attendee email I hold. */
async function knownContactFor(c: CandidateRow, db: Db = pool()): Promise<string | null> {
  const mine = (id: string | null | undefined) =>
    id ? one<{ id: string }>("SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [id, c.owner_user_id], db) : Promise.resolve(null);
  const direct = await mine(c.contact_id);
  if (direct) return direct.id;
  if (c.meeting_id) {
    const p = await one<{ contact_id: string }>(
      `SELECT mp.contact_id FROM meeting_participants mp JOIN contacts ct ON ct.id=mp.contact_id AND ct.owner_user_id=$2 AND ct.deleted_at IS NULL
       WHERE mp.meeting_id=$1 ORDER BY ct.full_name LIMIT 1`,
      [c.meeting_id, c.owner_user_id],
      db,
    );
    if (p) return p.contact_id;
  }
  const emails = (Array.isArray(c.attendees) ? c.attendees : []).map((a) => a?.email?.toLowerCase()).filter(Boolean) as string[];
  if (emails.length) {
    const hit = await one<{ id: string }>("SELECT id FROM contacts WHERE owner_user_id=$1 AND deleted_at IS NULL AND lower(email) = ANY($2::text[]) LIMIT 1", [c.owner_user_id, emails], db);
    if (hit) return hit.id;
  }
  return null;
}

async function composeFor(c: CandidateRow, contactId: string, db: Db = pool()): Promise<PrepBrief> {
  const userId = c.owner_user_id;
  const contact = await one<{ id: string; full_name: string; job_title: string | null; company: string | null; linked_user_id: string | null }>(
    "SELECT ct.id, ct.full_name, ct.job_title, co.name AS company, ct.linked_user_id FROM contacts ct LEFT JOIN companies co ON co.id=ct.company_id WHERE ct.id=$1",
    [contactId],
    db,
  );
  if (!contact) throw notFound("contact");
  const last = await one<{ occurred_at: Date; place_label: string | null; n: number }>(
    `SELECT occurred_at, place_label, (SELECT count(*)::int FROM encounters WHERE owner_user_id=$1 AND contact_id=$2) AS n
     FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1`,
    [userId, contactId],
    db,
  );
  // the owner's own notes only (never another member's org note)
  const note = await one<{ body: string; created_at: Date }>(
    "SELECT body, created_at FROM notes WHERE owner_user_id=$1 AND contact_id=$2 AND organization_id IS NULL ORDER BY created_at DESC LIMIT 1",
    [userId, contactId],
    db,
  );
  const actions = await q<{ description: string; due_at: Date | null }>(
    "SELECT description, due_at FROM action_items WHERE owner_user_id=$1 AND contact_id=$2 AND status='open' ORDER BY due_at NULLS LAST LIMIT 3",
    [userId, contactId],
    db,
  );
  const myPid = await primaryProfileId(userId, db);
  const me = myPid ? await loadProfile(myPid, db) : null;
  let theirs: Awaited<ReturnType<typeof loadProfile>> = null;
  if (contact.linked_user_id) {
    const pid = await primaryProfileId(contact.linked_user_id, db);
    theirs = pid ? await loadProfile(pid, db) : null;
  }
  const confirmed = (xs: { text: string; confirmed: boolean }[] | undefined) => (xs ?? []).filter((x) => x.confirmed).map((x) => x.text);
  return composePrepBrief({
    meetingTitle: c.title,
    startsAt: c.starts_at,
    location: c.location,
    contact: { id: contact.id, fullName: contact.full_name, company: contact.company, jobTitle: contact.job_title },
    lastEncounter: last ? { at: last.occurred_at, place: last.place_label } : null,
    encounterCount: last?.n ?? 0,
    recentNote: note ? { body: note.body, at: note.created_at } : null,
    openActions: actions.map((a) => ({ description: a.description, dueAt: a.due_at })),
    // their card: only what the matching opt-in + confirmation rules allow (confirmed offers/needs)
    theirOffers: theirs?.matchingOptIn ? confirmed(theirs.offers) : [],
    theirNeeds: theirs?.matchingOptIn ? confirmed(theirs.needs) : [],
    myOffers: confirmed(me?.offers),
    myNeeds: confirmed(me?.needs),
  });
}

const CAND_COLS = "id, owner_user_id, title, starts_at, location, contact_id, meeting_id, attendees";

/** GET /prep-briefs/{candidateId} — on demand for the owner (any approved upcoming/past entry with a known contact). */
export async function getPrepBrief(ctx: Ctx, candidateId: string) {
  if (!ctx.userId) throw unauthorized();
  const c = await one<CandidateRow>(`SELECT ${CAND_COLS} FROM calendar_candidates WHERE id=$1 AND owner_user_id=$2 AND status='approved'`, [candidateId, ctx.userId]);
  if (!c) throw notFound("calendar entry");
  const contactId = await knownContactFor(c);
  if (!contactId) return { candidateId, title: c.title, startsAt: c.starts_at.toISOString(), location: c.location, brief: null, reason: "no_known_contact" as const };
  const brief = await composeFor(c, contactId);
  return { candidateId, title: c.title, startsAt: c.starts_at.toISOString(), location: c.location, brief, reason: null };
}

/** Upcoming approved entries (next 7 days) for /app/brief. */
export async function upcomingBriefs(ctx: Ctx) {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<CandidateRow>(
    `SELECT ${CAND_COLS} FROM calendar_candidates WHERE owner_user_id=$1 AND status='approved' AND starts_at > now() - interval '1 hour' AND starts_at < now() + interval '7 days' ORDER BY starts_at LIMIT 20`,
    [ctx.userId],
  );
  const out = [];
  for (const r of rows) {
    const contactId = await knownContactFor(r);
    const contact = contactId ? await one<{ full_name: string }>("SELECT full_name FROM contacts WHERE id=$1", [contactId]) : null;
    out.push({ candidateId: r.id, title: r.title, startsAt: r.starts_at.toISOString(), location: r.location, contactId, contactName: contact?.full_name ?? null });
  }
  return { prefs: await getPrefs(ctx.userId), upcoming: out };
}

/** Worker: push/inbox a brief `lead` minutes before each approved meeting with a known contact (once per entry). */
export async function processPrepBriefs(now = new Date(), limit = 100): Promise<number> {
  const due = await q<CandidateRow & { lead: number }>(
    `SELECT cc.id, cc.owner_user_id, cc.title, cc.starts_at, cc.location, cc.contact_id, cc.meeting_id, cc.attendees, COALESCE(p.prep_brief_lead_min, 30) AS lead
     FROM calendar_candidates cc JOIN users u ON u.id=cc.owner_user_id AND u.status='active'
     LEFT JOIN user_assistant_prefs p ON p.user_id=cc.owner_user_id
     WHERE cc.status='approved' AND COALESCE(p.prep_brief_lead_min, 30) > 0
       AND cc.starts_at > $1 AND cc.starts_at <= $1 + make_interval(mins => COALESCE(p.prep_brief_lead_min, 30))
       AND NOT EXISTS (SELECT 1 FROM prep_brief_deliveries d WHERE d.candidate_id=cc.id)
     ORDER BY cc.starts_at LIMIT $2`,
    [now, limit],
  );
  let sent = 0;
  for (const c of due) {
    try {
      const contactId = await knownContactFor(c);
      if (!contactId) continue; // only meetings with someone I already know
      const brief = await composeFor(c, contactId);
      const minutes = Math.max(1, Math.round((c.starts_at.getTime() - now.getTime()) / 60_000));
      const name = brief.items[0]?.text.split(" — ")[0] ?? "";
      await tx(async (db) => {
        const ins = await db.query("INSERT INTO prep_brief_deliveries (candidate_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [c.id, c.owner_user_id]);
        if (!ins.rowCount) return;
        await notify(db, c.owner_user_id, { kind: "prep.brief", title: `${minutes}분 뒤 ${name}님과 「${c.title}」`.slice(0, 120), body: prepBriefNotificationBody(brief), url: `/app/brief/${c.id}`, dedupeKey: `prep:${c.id}` });
        sent++;
      });
    } catch (e) {
      log("warn", "prep_brief.failed", { candidate: c.id, error: (e as Error).message });
    }
  }
  return sent;
}

// ---------------------------------------------------------------- X-006 re-connect digest

interface DigestItem extends CoolingCandidate {
  lastPlace: string | null;
}

async function buildDigestItems(userId: string, today: Date): Promise<DigestItem[]> {
  const cooling = await coolingRelationships({ userId, ip: "", userAgent: "worker", requestId: "digest" }, 50);
  // skip people already suggested in the previous 3 weeks
  const recent = await q<{ items: { contactId: string }[] }>("SELECT items FROM reconnect_digests WHERE user_id=$1 AND week_start >= $2::date - 21 AND week_start < $2::date", [userId, weekStart(today)]);
  const nudged = new Set(recent.flatMap((r) => (r.items ?? []).map((i) => i.contactId)));
  const picked = pickReconnectDigest(cooling.results.map((r) => ({ contactId: r.contactId, fullName: r.fullName, company: r.company, daysSilent: r.daysSilent, level: r.level ?? "medium", reasons: r.reasons })), nudged, 3);
  const out: DigestItem[] = [];
  for (const p of picked) {
    const last = await one<{ place_label: string | null }>("SELECT place_label FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1", [userId, p.contactId]);
    out.push({ ...p, lastPlace: last?.place_label ?? null });
  }
  return out;
}

/** Create (once per week) and announce the digest. Returns null when this week's digest already exists. */
export async function generateDigest(userId: string, today = new Date(), opts: { notifyUser?: boolean } = {}) {
  const week = weekStart(today);
  const items = await buildDigestItems(userId, today);
  const row = await one<{ id: string }>(
    "INSERT INTO reconnect_digests (user_id, week_start, items) VALUES ($1,$2,$3) ON CONFLICT (user_id, week_start) DO NOTHING RETURNING id",
    [userId, week, JSON.stringify(items)],
  );
  if (!row) return null;
  if (items.length && opts.notifyUser !== false) {
    await notify(pool(), userId, { kind: "reconnect.digest", title: `이번 주 다시 연락해 볼 ${items.length}명`, body: items.map((i) => i.fullName).join(", "), url: "/app/reconnect", dedupeKey: `reconnect:${week}` });
    const prefs = await getPrefs(userId);
    if (prefs.reconnectEmail) {
      // to the OWNER only (a reminder), never to the contacts; drafts stay drafts until the user sends them
      const u = await one<{ email: string | null }>("SELECT email FROM users WHERE id=$1", [userId]);
      if (u?.email) {
        await sendMail(u.email, `[LINKOS] 이번 주 다시 연락해 볼 ${items.length}명`, `${items.map((i) => `- ${i.fullName}${i.company ? ` (${i.company})` : ""} · ${i.daysSilent}일째 연락 없음`).join("\n")}\n\n한 번에 안부 초안을 만들 수 있어요: ${appOrigin()}/app/reconnect\n(초안은 자동으로 보내지지 않습니다.)`).catch(() => false);
      }
    }
  }
  return { id: row.id, weekStart: week, items };
}

/** Worker: weekly digests for users who keep it on (default on). */
export async function processReconnectDigests(today = new Date(), limit = 25): Promise<number> {
  const users = await q<{ id: string }>(
    `SELECT u.id FROM users u LEFT JOIN user_assistant_prefs p ON p.user_id=u.id
     WHERE u.status='active' AND NOT u.is_guest AND u.deleted_at IS NULL AND COALESCE(p.reconnect_digest, true)
       AND EXISTS (SELECT 1 FROM contacts c WHERE c.owner_user_id=u.id AND c.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM reconnect_digests d WHERE d.user_id=u.id AND d.week_start=$1)
     LIMIT $2`,
    [weekStart(today), limit],
  );
  let n = 0;
  for (const u of users) {
    try {
      if (await generateDigest(u.id, today)) n++;
    } catch (e) {
      log("warn", "reconnect_digest.failed", { error: (e as Error).message });
    }
  }
  return n;
}

/** GET /reconnect/digest — this week's digest (built on demand if the worker has not run yet). */
export async function currentDigest(ctx: Ctx, today = new Date()) {
  if (!ctx.userId) throw unauthorized();
  const week = weekStart(today);
  let row = await one<{ id: string; week_start: string; items: DigestItem[]; created_at: Date }>("SELECT id, week_start::text, items, created_at FROM reconnect_digests WHERE user_id=$1 AND week_start=$2", [ctx.userId, week]);
  if (!row) {
    await generateDigest(ctx.userId, today, { notifyUser: false });
    row = await one("SELECT id, week_start::text, items, created_at FROM reconnect_digests WHERE user_id=$1 AND week_start=$2", [ctx.userId, week]);
  }
  const ids = (row?.items ?? []).map((i) => i.contactId);
  const drafts = ids.length
    ? await q<{ contact_id: string; id: string }>("SELECT DISTINCT ON (contact_id) contact_id, id FROM messages WHERE owner_user_id=$1 AND contact_id = ANY($2::uuid[]) AND created_at >= $3 ORDER BY contact_id, created_at DESC", [ctx.userId, ids, row!.created_at])
    : [];
  const draftOf = new Map(drafts.map((d) => [d.contact_id, d.id]));
  const prefs = await getPrefs(ctx.userId);
  return {
    weekStart: week,
    enabled: prefs.reconnectDigest,
    items: (row?.items ?? []).map((i) => ({ ...i, provenance: "ai_inferred" as const, draftMessageId: draftOf.get(i.contactId) ?? null })),
  };
}

/** One-tap draft (saved to /app/messages as a draft; never sent automatically). */
export async function createReconnectDraft(ctx: Ctx, contactId: string) {
  if (!ctx.userId) throw unauthorized();
  const c = await one<{ full_name: string; company: string | null; email: string | null }>(
    "SELECT ct.full_name, co.name AS company, ct.email FROM contacts ct LEFT JOIN companies co ON co.id=ct.company_id WHERE ct.id=$1 AND ct.owner_user_id=$2 AND ct.deleted_at IS NULL",
    [contactId, ctx.userId],
  );
  if (!c) throw notFound("contact");
  const last = await one<{ place_label: string | null }>("SELECT place_label FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1", [ctx.userId, contactId]);
  const pid = await primaryProfileId(ctx.userId);
  const me = pid ? await one<{ name: string }>("SELECT name FROM profiles WHERE id=$1", [pid]) : null;
  const d = reconnectDraft({ fullName: c.full_name, company: c.company, lastPlace: last?.place_label ?? null, senderName: me?.name ?? null });
  const msg = await createMessage(ctx, { contactId, channel: "email", subject: d.subject, body: d.body, language: "ko", provenance: "rules" });
  return { ...msg, needsConfirmation: true };
}
