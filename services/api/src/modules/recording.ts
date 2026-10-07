// recording module — F-081 회의 녹음(동의 후), F-082 전사+언어 감지, F-083 화자분리,
// F-084~F-086 전사 기반 요약/To-do/약속 제안(근거 세그먼트 연결, 사용자 확인 전까지 'suggested').
// The browser records self-contained audio parts (MediaRecorder restarted every ~50s) and uploads each part
// while recording; each part is inspected (F-172), encrypted and stored, and transcribed independently with its
// time offset. Speaker labels come from the provider per part (S1, S2…).
import { dominantLanguage, extractCommitments, linkEvidence, offsetSegments, transcriptText } from "@linkos/domain";
import { z } from "zod";
import { one, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit, log } from "../lib/platform";
import { sttProvider } from "../lib/stt";
import { extractMeeting } from "./assist";
import { deleteStoredObject, readObjectBytes, storeObject } from "./files";

export const PART_SECONDS = 50;
export const MAX_PARTS = 360; // ≈ 5 hours
const MAX_STT_ATTEMPTS = 5;

export const startInput = z.object({ mimeType: z.string().max(100).regex(/^audio\/[a-z0-9.+-]+(;.*)?$/i).default("audio/webm") }).partial();
export const partMeta = z.object({ offsetMs: z.coerce.number().int().min(0).max(24 * 3600_000).default(0), durationMs: z.coerce.number().int().min(0).max(3600_000).nullish() });
export const finalizeInput = z.object({ durationSeconds: z.number().int().min(0).max(24 * 3600).nullish() });

const retentionDays = () => Number(process.env.RECORDING_RETENTION_DAYS ?? 180);

async function ownedMeeting(userId: string, meetingId: string) {
  const m = await one<{ consent_status: string }>("SELECT consent_status FROM meetings WHERE id=$1 AND owner_user_id=$2", [meetingId, userId]);
  if (!m) throw notFound("meeting");
  return m;
}

/** POST /meetings/{id}/recordings — principle 7: never without a recorded consent. */
export async function startRecording(ctx: Ctx, meetingId: string, input: z.infer<typeof startInput> = {}) {
  if (!ctx.userId) throw unauthorized();
  const m = await ownedMeeting(ctx.userId, meetingId);
  if (m.consent_status !== "granted") throw new ApiError(409, "recording_consent_required", "녹음 동의가 기록되지 않아 녹음을 시작할 수 없습니다.");
  const userId = ctx.userId;
  return tx(async (c) => {
    const r = await one<{ id: string; created_at: Date }>(
      "INSERT INTO recordings (meeting_id, owner_user_id, object_key, status, mime_type) VALUES ($1,$2,$3,'recording',$4) RETURNING id, created_at",
      [meetingId, userId, `recording-part/${meetingId}`, input.mimeType ?? "audio/webm"],
      c,
    );
    await audit(c, ctx, "meeting.recording_started", "meeting", meetingId, { recordingId: r!.id });
    return { id: r!.id, status: "recording", partSeconds: PART_SECONDS, maxParts: MAX_PARTS, transcription: sttProvider()?.name ?? null, createdAt: r!.created_at };
  });
}

/** PUT /meetings/{id}/recordings/{rid}/parts/{seq} — idempotent per (recording, seq). */
export async function uploadPart(ctx: Ctx, meetingId: string, recordingId: string, seq: number, bytes: Buffer, meta: z.infer<typeof partMeta>) {
  if (!ctx.userId) throw unauthorized();
  if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_PARTS) throw badRequest("invalid_part", "잘못된 파트 번호입니다.");
  const m = await ownedMeeting(ctx.userId, meetingId);
  if (m.consent_status !== "granted") throw new ApiError(409, "recording_consent_required", "녹음 동의가 철회되어 업로드할 수 없습니다.");
  const rec = await one<{ status: string; mime_type: string }>("SELECT status, mime_type FROM recordings WHERE id=$1 AND meeting_id=$2", [recordingId, meetingId]);
  if (!rec) throw notFound("recording");
  const existing = await one<{ object_id: string }>("SELECT object_id FROM recording_parts WHERE recording_id=$1 AND seq=$2", [recordingId, seq]);
  if (existing) return { recordingId, seq, duplicate: true };
  if (rec.status !== "recording") throw new ApiError(409, "recording_closed", "이미 종료된 녹음입니다.");
  const obj = await storeObject({ ownerUserId: ctx.userId, purpose: "recording_part", bytes, filename: `part-${seq}`, retentionDays: retentionDays(), metadata: { recordingId, seq } });
  if (obj.scanStatus === "quarantined") {
    await deleteStoredObject(obj.id);
    throw new ApiError(422, "file_quarantined", "보안 검사를 통과하지 못한 오디오입니다.");
  }
  try {
    const inserted = await tx(async (c) => {
      const r = await c.query(
        "INSERT INTO recording_parts (recording_id, seq, object_id, offset_ms, duration_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (recording_id, seq) DO NOTHING",
        [recordingId, seq, obj.id, meta.offsetMs, meta.durationMs ?? null],
      );
      if (r.rowCount) await c.query("UPDATE recordings SET part_count = part_count + 1, byte_size = byte_size + $2, mime_type = COALESCE(mime_type, $3) WHERE id=$1", [recordingId, obj.byteSize, obj.contentType]);
      return (r.rowCount ?? 0) > 0;
    });
    if (!inserted) {
      await deleteStoredObject(obj.id);
      return { recordingId, seq, duplicate: true };
    }
  } catch (e) {
    await deleteStoredObject(obj.id);
    throw e;
  }
  return { recordingId, seq, duplicate: false, byteSize: obj.byteSize };
}

/** POST /meetings/{id}/recordings/{rid}/finalize — closes the recording; transcription continues in the worker. */
export async function finalizeRecording(ctx: Ctx, meetingId: string, recordingId: string, input: z.infer<typeof finalizeInput>) {
  if (!ctx.userId) throw unauthorized();
  await ownedMeeting(ctx.userId, meetingId);
  const provider = sttProvider();
  return tx(async (c) => {
    const r = await one<{ status: string; part_count: number }>("SELECT status, part_count FROM recordings WHERE id=$1 AND meeting_id=$2 FOR UPDATE", [recordingId, meetingId], c);
    if (!r) throw notFound("recording");
    if (r.status === "recording") {
      const next = r.part_count === 0 ? "empty" : provider ? "transcribing" : "stored";
      await c.query("UPDATE recordings SET status=$2, duration_seconds=$3, finalized_at=now(), stt_provider=$4, error=$5 WHERE id=$1", [
        recordingId, next, input.durationSeconds ?? null, provider?.name ?? null, provider ? null : "stt_not_configured",
      ]);
      await audit(c, ctx, "meeting.recording_finalized", "meeting", meetingId, { recordingId, parts: r.part_count });
      return { id: recordingId, status: next, parts: r.part_count, transcription: provider?.name ?? null };
    }
    return { id: recordingId, status: r.status, parts: r.part_count, transcription: provider?.name ?? null };
  });
}

/** GET /meetings/{id}/transcript — segments with speaker keys/timestamps + recording states. */
export async function getTranscript(ctx: Ctx, meetingId: string) {
  if (!ctx.userId) throw unauthorized();
  await ownedMeeting(ctx.userId, meetingId);
  const recordings = await q<any>(
    `SELECT r.id, r.status, r.part_count, r.byte_size, r.duration_seconds, r.language, r.stt_provider, r.error, r.created_at, r.transcribed_at,
       (SELECT count(*)::int FROM recording_parts p WHERE p.recording_id=r.id AND p.stt_status='done') AS parts_done,
       (SELECT count(*)::int FROM recording_parts p WHERE p.recording_id=r.id AND p.stt_status='failed') AS parts_failed
     FROM recordings r WHERE r.meeting_id=$1 ORDER BY r.created_at`,
    [meetingId],
  );
  const segments = await q<any>("SELECT id, recording_id, speaker_key, start_ms, end_ms, text, confidence, language FROM transcript_segments WHERE meeting_id=$1 ORDER BY recording_id, start_ms, id", [meetingId]);
  return {
    recordings: recordings.map((r) => ({
      id: r.id, status: r.status, parts: r.part_count, partsDone: r.parts_done, partsFailed: r.parts_failed, byteSize: Number(r.byte_size), durationSeconds: r.duration_seconds,
      language: r.language, provider: r.stt_provider, error: r.error, createdAt: r.created_at, transcribedAt: r.transcribed_at,
    })),
    segments: segments.map((s) => ({ id: String(s.id), recordingId: s.recording_id, speaker: s.speaker_key, startMs: s.start_ms, endMs: s.end_ms, text: s.text, confidence: s.confidence === null ? null : Number(s.confidence), language: s.language })),
  };
}

// ---------------------------------------------------------------- worker

/** Transcribe pending parts (claim → STT outside any transaction → write segments in a short transaction). */
export async function processTranscriptions(limit = 4): Promise<number> {
  const provider = sttProvider();
  if (!provider) return 0;
  const claimed = await tx(async (c) => {
    const r = await c.query<{ recording_id: string; seq: number; object_id: string; offset_ms: number; meeting_id: string; mime_type: string | null }>(
      `UPDATE recording_parts p SET stt_attempts = stt_attempts + 1
       FROM recordings r
       WHERE r.id = p.recording_id AND (p.recording_id, p.seq) IN (
         SELECT p2.recording_id, p2.seq FROM recording_parts p2 JOIN recordings r2 ON r2.id=p2.recording_id
         WHERE p2.stt_status='pending' AND p2.stt_attempts < $2 AND r2.status IN ('recording','transcribing')
         ORDER BY p2.created_at LIMIT $1 FOR UPDATE OF p2 SKIP LOCKED)
       RETURNING p.recording_id, p.seq, p.object_id, p.offset_ms, r.meeting_id, r.mime_type`,
      [limit, MAX_STT_ATTEMPTS],
    );
    return r.rows;
  });
  for (const part of claimed) {
    try {
      const audio = await readObjectBytes(part.object_id);
      const result = await provider.transcribe(audio.bytes, audio.contentType || part.mime_type || "audio/webm");
      const segs = offsetSegments(result.segments, part.offset_ms);
      await tx(async (c) => {
        await c.query("DELETE FROM transcript_segments WHERE recording_id=$1 AND part_seq=$2", [part.recording_id, part.seq]);
        for (const s of segs) {
          await c.query(
            "INSERT INTO transcript_segments (meeting_id, recording_id, part_seq, speaker_key, start_ms, end_ms, text, confidence, language) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [part.meeting_id, part.recording_id, part.seq, s.speaker, s.startMs, s.endMs, s.text.slice(0, 5000), s.confidence, result.language],
          );
        }
        await c.query("UPDATE recording_parts SET stt_status='done', stt_error=NULL, language=$3 WHERE recording_id=$1 AND seq=$2", [part.recording_id, part.seq, result.language]);
      });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      log("warn", "stt.part_failed", { recordingId: part.recording_id, seq: part.seq, error: msg });
      await q("UPDATE recording_parts SET stt_error=$3, stt_status = CASE WHEN stt_attempts >= $4 THEN 'failed' ELSE 'pending' END WHERE recording_id=$1 AND seq=$2", [part.recording_id, part.seq, msg, MAX_STT_ATTEMPTS]);
    }
  }
  await completeTranscripts();
  return claimed.length;
}

/** Finalized recordings whose parts are all processed → transcript.ready → suggestions. */
export async function completeTranscripts(): Promise<number> {
  const ready = await q<{ id: string; meeting_id: string; owner_user_id: string }>(
    `SELECT r.id, r.meeting_id, r.owner_user_id FROM recordings r
     WHERE r.status='transcribing' AND r.finalized_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM recording_parts p WHERE p.recording_id=r.id AND p.stt_status='pending')
     LIMIT 10`,
  );
  for (const r of ready) {
    const done = await tx(async (c) => {
      const langs = await c.query<{ language: string | null }>("SELECT language FROM recording_parts WHERE recording_id=$1 AND stt_status='done'", [r.id]);
      const failed = await c.query("SELECT 1 FROM recording_parts WHERE recording_id=$1 AND stt_status='failed'", [r.id]);
      const upd = await c.query(
        "UPDATE recordings SET status='transcribed', language=$2, transcribed_at=now(), error=$3 WHERE id=$1 AND status='transcribing'",
        [r.id, dominantLanguage(langs.rows.map((l) => l.language)), failed.rowCount ? "some_parts_failed" : null],
      );
      if (!upd.rowCount) return false;
      await emit(c, "meeting.transcript.ready", "meeting", r.meeting_id, { meeting_id: r.meeting_id, transcript_ref: r.id });
      return true;
    });
    if (done) await suggestFromTranscript(r.owner_user_id, r.meeting_id, r.id).catch((e) => log("warn", "transcript.suggest_failed", { error: (e as Error).message }));
  }
  // retry suggestion generation that failed earlier
  const pending = await q<{ id: string; meeting_id: string; owner_user_id: string }>("SELECT id, meeting_id, owner_user_id FROM recordings WHERE status='transcribed' AND transcribed_at < now() - interval '1 minute' LIMIT 5");
  for (const r of pending) await suggestFromTranscript(r.owner_user_id, r.meeting_id, r.id).catch(() => undefined);
  return ready.length;
}

/**
 * F-084~F-086 on a transcript: assist.extractMeeting (Claude when configured, else marked-line rules) plus the
 * deterministic commitment extractor; every suggestion is linked to its evidence segments and stays 'suggested'
 * (AI 추론 label) until the user confirms it.
 */
export async function suggestFromTranscript(ownerUserId: string, meetingId: string, recordingId: string) {
  const segRows = await q<{ id: string; speaker_key: string | null; text: string }>("SELECT id, speaker_key, text FROM transcript_segments WHERE recording_id=$1 ORDER BY start_ms, id", [recordingId]);
  const segments = segRows.map((s) => ({ id: String(s.id), speaker: s.speaker_key, text: s.text }));
  if (!segments.length) {
    await q("UPDATE recordings SET status='analyzed' WHERE id=$1", [recordingId]);
    return { actionItemIds: [] as string[] };
  }
  const ctx: Ctx = { userId: ownerUserId, ip: "worker", userAgent: "worker", requestId: `stt-${recordingId}` };
  const ext = await extractMeeting(ctx, meetingId, transcriptText(segments));
  const rules = extractCommitments(segments);
  type Item = { text: string; segmentIds: string[]; dueHint?: string };
  const link = (t: string) => linkEvidence(t, segments).map(String);
  const uniq = <T extends { text: string }>(xs: T[]) => xs.filter((x, i) => x.text && xs.findIndex((y) => y.text === x.text) === i);
  let actions: Item[] = ext.result.actionItems.map((a) => ({ text: a.description, dueHint: a.dueHint, segmentIds: link(a.description) }));
  let decisions: Item[] = ext.result.decisions.map((d) => ({ text: d, segmentIds: link(d) }));
  let promises: (Item & { by: "me" | "them" })[] = ext.result.promises.map((p) => ({ text: p.text, by: p.by, segmentIds: link(p.text) }));
  if (ext.provenance !== "ai_inferred") {
    actions = uniq([...actions, ...rules.actionItems.map((a) => ({ text: a.text, dueHint: a.dueHint, segmentIds: a.segmentIds.map(String) }))]);
    decisions = uniq([...decisions, ...rules.decisions.map((d) => ({ text: d.text, segmentIds: d.segmentIds.map(String) }))]);
    promises = uniq([...promises, ...rules.promises.map((p) => ({ text: p.text, by: "me" as const, segmentIds: p.segmentIds.map(String) }))]);
  }
  const provenance = ext.provenance === "ai_inferred" ? "ai_inferred" : "rules";
  return tx(async (c) => {
    await c.query("DELETE FROM action_items WHERE meeting_id=$1 AND status='suggested'", [meetingId]);
    const ids: string[] = [];
    for (const a of actions.slice(0, 50)) {
      const r = await one<{ id: string }>(
        "INSERT INTO action_items (meeting_id, owner_user_id, description, status, source_segment_ids, provenance, due_hint) VALUES ($1,$2,$3,'suggested',$4,$5,$6) RETURNING id",
        [meetingId, ownerUserId, a.text.slice(0, 500), a.segmentIds.map(Number), provenance, a.dueHint || null],
        c,
      );
      ids.push(r!.id);
    }
    const ai = { recordingId, provenance, model: ext.model, summary: ext.result.summary, decisions, promises, nextMeetingHint: ext.result.nextMeetingHint, createdAt: new Date().toISOString() };
    await c.query("UPDATE meetings SET summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('ai', $2::jsonb) WHERE id=$1", [meetingId, JSON.stringify(ai)]);
    await c.query("UPDATE recordings SET status='analyzed' WHERE id=$1", [recordingId]);
    if (ids.length) await emit(c, "meeting.actions.extracted", "meeting", meetingId, { meeting_id: meetingId, action_item_ids: ids });
    return { actionItemIds: ids };
  });
}

/** F-102 Human confirmation for a suggested action item: accept → open To-do, reject → removed. */
export async function confirmSuggestedAction(ctx: Ctx, meetingId: string, actionId: string, accept: boolean, patch: { description?: string; dueAt?: string | null; contactId?: string | null } = {}) {
  if (!ctx.userId) throw unauthorized();
  await ownedMeeting(ctx.userId, meetingId);
  if (patch.contactId) {
    const ok = await one("SELECT 1 FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL", [patch.contactId, ctx.userId]);
    if (!ok) throw notFound("contact");
  }
  return tx(async (c) => {
    const a = await one<{ id: string }>("SELECT id FROM action_items WHERE id=$1 AND meeting_id=$2 AND status='suggested' FOR UPDATE", [actionId, meetingId], c);
    if (!a) throw notFound("suggestion");
    if (!accept) {
      await c.query("DELETE FROM action_items WHERE id=$1", [actionId]);
    } else {
      await c.query(
        "UPDATE action_items SET status='open', description=COALESCE($2, description), due_at=$3, contact_id=$4 WHERE id=$1",
        [actionId, patch.description ?? null, patch.dueAt ?? null, patch.contactId ?? null],
      );
      await c.query("UPDATE ai_runs SET user_confirmed=true WHERE owner_user_id=$1 AND kind='meeting_extract' AND $2 = ANY(source_ids)", [ctx.userId, meetingId]);
    }
    await audit(c, ctx, accept ? "meeting.suggestion_accepted" : "meeting.suggestion_rejected", "meeting", meetingId, { actionId });
    return { id: actionId, status: accept ? "open" : "rejected" };
  });
}

