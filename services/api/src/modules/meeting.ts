// meeting module — Meeting Intelligence (F-0xx): Meeting Card(목적·논의·결정·약속·To-do·다음 일정), 녹음 동의 게이트, Pre-meeting Brief
import { canStartRecording } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit } from "../lib/platform";
import { recordConsents } from "./identity";
import { assertRecordingPolicy } from "./policy";
import { primaryProfileId, loadProfile } from "./card";
import { startRecording } from "./recording";
import { textSimilarity } from "@linkos/domain";

export const meetingInput = z.object({
  title: z.string().trim().min(1).max(200),
  purpose: z.string().trim().max(1000).nullish(),
  startedAt: z.string().datetime().nullish(),
  endedAt: z.string().datetime().nullish(),
  nextMeetingAt: z.string().datetime().nullish(),
  participantContactIds: z.array(z.string().uuid()).max(50).default([]),
  discussion: z.array(z.string().max(1000)).max(50).default([]),
  decisions: z.array(z.string().max(500)).max(50).default([]),
  promises: z.array(z.object({ text: z.string().max(500), by: z.enum(["me", "them"]).default("me") })).max(50).default([]),
  actionItems: z
    .array(z.object({ id: z.string().uuid().optional(), description: z.string().max(500), dueAt: z.string().datetime().nullish(), contactId: z.string().uuid().nullish(), status: z.enum(["open", "done"]).default("open") }))
    .max(100)
    .default([]),
});
export type MeetingInput = z.infer<typeof meetingInput>;

async function assertContacts(userId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await q<{ id: string }>("SELECT id FROM contacts WHERE owner_user_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [userId, ids]);
  if (rows.length !== new Set(ids).size) throw notFound("contact");
}

export async function saveMeeting(ctx: Ctx, input: MeetingInput, meetingId?: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await assertContacts(userId, [...input.participantContactIds, ...input.actionItems.flatMap((a) => (a.contactId ? [a.contactId] : []))]);
  return tx(async (c) => {
    const summary = { discussion: input.discussion, decisions: input.decisions, promises: input.promises };
    let id = meetingId;
    if (id) {
      const r = await c.query(
        "UPDATE meetings SET title=$3, purpose=$4, started_at=$5, ended_at=$6, next_meeting_at=$7, summary=$8 WHERE id=$1 AND owner_user_id=$2",
        [id, userId, input.title, input.purpose ?? null, input.startedAt ?? null, input.endedAt ?? null, input.nextMeetingAt ?? null, JSON.stringify(summary)],
      );
      if (r.rowCount === 0) throw notFound("meeting");
      await c.query("DELETE FROM meeting_participants WHERE meeting_id=$1", [id]);
    } else {
      const r = await one<{ id: string }>(
        "INSERT INTO meetings (owner_user_id, title, purpose, started_at, ended_at, next_meeting_at, summary) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [userId, input.title, input.purpose ?? null, input.startedAt ?? null, input.endedAt ?? null, input.nextMeetingAt ?? null, JSON.stringify(summary)],
        c,
      );
      id = r!.id;
    }
    for (const cid of new Set(input.participantContactIds)) {
      await c.query("INSERT INTO meeting_participants (meeting_id, contact_id, role) VALUES ($1,$2,'attendee')", [id, cid]);
      await c.query("UPDATE relationships SET last_contact_at = GREATEST(COALESCE(last_contact_at,'epoch'), COALESCE($3::timestamptz, now())) WHERE owner_user_id=$1 AND contact_id=$2", [userId, cid, input.startedAt ?? null]);
      if (input.nextMeetingAt) await c.query("UPDATE relationships SET next_followup_at=$3 WHERE owner_user_id=$1 AND contact_id=$2", [userId, cid, input.nextMeetingAt]);
    }
    const keep: string[] = [];
    for (const a of input.actionItems) {
      if (a.id) {
        await c.query("UPDATE action_items SET description=$3, due_at=$4, contact_id=$5, status=$6 WHERE id=$1 AND meeting_id=$2 AND status <> 'suggested'", [a.id, id, a.description, a.dueAt ?? null, a.contactId ?? null, a.status]);
        keep.push(a.id);
      } else {
        const r = await one<{ id: string }>(
          "INSERT INTO action_items (meeting_id, owner_user_id, contact_id, description, due_at, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
          [id, userId, a.contactId ?? null, a.description, a.dueAt ?? null, a.status],
          c,
        );
        keep.push(r!.id);
      }
    }
    // AI suggestions (status 'suggested') are confirmed separately and never dropped by a card save
    await c.query("DELETE FROM action_items WHERE meeting_id=$1 AND status <> 'suggested' AND NOT (id = ANY($2::uuid[]))", [id, keep]);
    if (keep.length) await emit(c, "meeting.actions.extracted", "meeting", id!, { meeting_id: id!, action_item_ids: keep });
    await audit(c, ctx, meetingId ? "meeting.updated" : "meeting.created", "meeting", id!);
    return getMeeting(userId, id!, c);
  });
}

export async function getMeeting(userId: string, id: string, db: Db = pool()) {
  const m = await one<any>("SELECT * FROM meetings WHERE id=$1 AND owner_user_id=$2", [id, userId], db);
  if (!m) throw notFound("meeting");
  const participants = await q<any>(
    `SELECT c.id, c.full_name, co.name AS company FROM meeting_participants mp JOIN contacts c ON c.id = mp.contact_id LEFT JOIN companies co ON co.id = c.company_id WHERE mp.meeting_id=$1`,
    [id],
    db,
  );
  const allActions = await q<any>("SELECT id, description, due_at, status, contact_id, source_segment_ids, provenance, due_hint FROM action_items WHERE meeting_id=$1 ORDER BY due_at NULLS LAST, created_at, id", [id], db);
  const actions = allActions.filter((a) => a.status !== "suggested");
  const suggested = allActions.filter((a) => a.status === "suggested");
  const recordings = await q<any>("SELECT id, status, duration_seconds, part_count, language, error, created_at FROM recordings WHERE meeting_id=$1 ORDER BY created_at", [id], db);
  return {
    id: m.id,
    title: m.title,
    purpose: m.purpose,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    nextMeetingAt: m.next_meeting_at,
    consentStatus: m.consent_status,
    consentPolicy: m.consent_policy,
    discussion: m.summary?.discussion ?? [],
    decisions: m.summary?.decisions ?? [],
    promises: m.summary?.promises ?? [],
    participants: participants.map((p) => ({ id: p.id, fullName: p.full_name, company: p.company })),
    actionItems: actions.map((a) => ({ id: a.id, description: a.description, dueAt: a.due_at, status: a.status, contactId: a.contact_id, provenance: a.provenance, sourceSegmentIds: (a.source_segment_ids ?? []).map(String) })),
    // F-084~F-086: AI/rule suggestions from the transcript, each with evidence segment ids (AI 추론 · 확인 필요)
    suggestedActions: suggested.map((a) => ({ id: a.id, description: a.description, dueHint: a.due_hint, provenance: a.provenance, sourceSegmentIds: (a.source_segment_ids ?? []).map(String) })),
    ai: m.summary?.ai ?? null,
    recordings,
    createdAt: m.created_at,
  };
}

export async function listMeetings(userId: string) {
  return q<any>(
    `SELECT m.id, m.title, m.started_at, m.next_meeting_at, m.created_at,
       (SELECT count(*)::int FROM action_items a WHERE a.meeting_id=m.id AND a.status='open') AS open_actions
     FROM meetings m WHERE m.owner_user_id=$1 ORDER BY COALESCE(m.started_at, m.created_at) DESC LIMIT 100`,
    [userId],
  );
}

/** F-084 녹음 동의: consent record + participant acknowledgement before any recording. */
export async function setRecordingConsent(ctx: Ctx, meetingId: string, body: { ownerConsent: boolean; participantsAcknowledged: boolean; policy: "all_party" | "one_party_notice" }) {
  if (!ctx.userId) throw unauthorized();
  return tx(async (c) => {
    const m = await one<{ id: string }>("SELECT id FROM meetings WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [meetingId, ctx.userId], c);
    if (!m) throw notFound("meeting");
    // F-139: an org may require all-party recording consent for its members
    await assertRecordingPolicy(ctx.userId!, body.policy, c);
    await recordConsents(c, ctx.userId!, [{ type: "recording", granted: body.ownerConsent }], { meetingId, participantsAcknowledged: body.participantsAcknowledged, policy: body.policy });
    const gate = canStartRecording({ ownerConsented: body.ownerConsent, participantsAcknowledged: body.participantsAcknowledged, policy: body.policy });
    await c.query("UPDATE meetings SET consent_status=$2, consent_policy=$3 WHERE id=$1", [meetingId, gate.ok ? "granted" : "denied", body.policy]);
    await audit(c, ctx, "meeting.recording_consent", "meeting", meetingId, { ok: gate.ok, policy: body.policy });
    return { consentStatus: gate.ok ? "granted" : "denied", reason: gate.reason ?? null };
  });
}

/** POST /meetings/{id}/recordings — blocked without consent (F-081); parts are uploaded to encrypted storage. */
export async function createRecording(ctx: Ctx, meetingId: string, input: { mimeType?: string } = {}) {
  return startRecording(ctx, meetingId, input);
}

/** GET /meetings/{id}/brief — 30초 Pre-meeting Brief. Deterministic, sourced from the user's own data (provenance listed). */
export async function getMeetingBrief(ctx: Ctx, meetingId: string) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const meeting = await getMeeting(userId, meetingId);
  const myProfileId = await primaryProfileId(userId);
  const me = myProfileId ? await loadProfile(myProfileId) : null;
  const people = [];
  for (const p of meeting.participants) {
    const last = await one<any>("SELECT occurred_at, place_label, note FROM encounters WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC LIMIT 1", [userId, p.id]);
    const openActions = await q<any>("SELECT description, due_at FROM action_items WHERE owner_user_id=$1 AND contact_id=$2 AND status='open' ORDER BY due_at NULLS LAST LIMIT 5", [userId, p.id]);
    const notes = await q<any>("SELECT body, created_at FROM notes WHERE owner_user_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 3", [userId, p.id]);
    const contact = await one<any>("SELECT linked_user_id, job_title, updated_at FROM contacts WHERE id=$1", [p.id]);
    let theirProfile: Awaited<ReturnType<typeof loadProfile>> = null;
    if (contact?.linked_user_id) {
      const pid = await primaryProfileId(contact.linked_user_id);
      theirProfile = pid ? await loadProfile(pid) : null;
    }
    const topics: string[] = [];
    if (me && theirProfile) {
      for (const n of me.needs) for (const o of theirProfile.offers) if (textSimilarity(n.text, o.text) > 0.2) topics.push(`내 Need “${n.text}” ↔ 상대 Offer “${o.text}”`);
      for (const o of me.offers) for (const n of theirProfile.needs) if (textSimilarity(o.text, n.text) > 0.2) topics.push(`상대 Need “${n.text}”에 내 Offer “${o.text}” 제안`);
    }
    people.push({
      contactId: p.id,
      fullName: p.fullName,
      company: p.company,
      lastEncounter: last,
      openActions,
      recentNotes: notes,
      profileUpdatedAt: theirProfile?.updatedAt ?? null,
      suggestedTopics: topics.slice(0, 3),
    });
  }
  await q("INSERT INTO ai_runs (owner_user_id, kind, model, prompt_version, source_ids, output) VALUES ($1,'meeting_brief','rules-v1','brief-1',$2,$3)", [userId, [meetingId, ...meeting.participants.map((p) => p.id)], JSON.stringify({ people: people.length })]);
  return { meetingId, title: meeting.title, purpose: meeting.purpose, people, provenance: "derived_from_your_records" };
}

export const followupInput = z.object({
  contactId: z.string().uuid().nullish(),
  kind: z.enum(["thank_you", "send_material", "check_in", "meeting_request", "custom"]).default("custom"),
  title: z.string().trim().min(1).max(200),
  bodyDraft: z.string().max(4000).nullish(),
  dueAt: z.string().datetime().nullish(),
});

export async function createFollowup(ctx: Ctx, input: z.infer<typeof followupInput>) {
  if (!ctx.userId) throw unauthorized();
  if (input.contactId) await assertContacts(ctx.userId, [input.contactId]);
  const r = await one<{ id: string }>(
    "INSERT INTO followups (owner_user_id, contact_id, kind, title, body_draft, due_at, source) VALUES ($1,$2,$3,$4,$5,$6,'user') RETURNING id",
    [ctx.userId, input.contactId ?? null, input.kind, input.title, input.bodyDraft ?? null, input.dueAt ?? null],
  );
  if (input.contactId && input.dueAt) await q("UPDATE relationships SET next_followup_at=$3 WHERE owner_user_id=$1 AND contact_id=$2", [ctx.userId, input.contactId, input.dueAt]);
  return { id: r!.id };
}

export async function listFollowups(userId: string, status: "open" | "done" = "open") {
  return q<any>(
    `SELECT f.id, f.kind, f.title, f.body_draft, f.due_at, f.status, f.source, f.contact_id, c.full_name
     FROM followups f LEFT JOIN contacts c ON c.id=f.contact_id WHERE f.owner_user_id=$1 AND f.status=$2 ORDER BY f.due_at NULLS LAST LIMIT 100`,
    [userId, status],
  );
}

export async function completeFollowup(ctx: Ctx, id: string, status: "done" | "dismissed" | "open") {
  if (!ctx.userId) throw unauthorized();
  const r = await one("UPDATE followups SET status=$3, completed_at = CASE WHEN $3='open' THEN NULL ELSE now() END WHERE id=$1 AND owner_user_id=$2 RETURNING id", [id, ctx.userId, status]);
  if (!r) throw notFound("followup");
  return { id, status };
}
