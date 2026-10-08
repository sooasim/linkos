// F-096 Pre-meeting Brief · F-089 관계 메모리 (pure, no I/O).
// Never fabricates: every item is copied verbatim from a stored record (meeting card, transcript, field history,
// Living Update suggestion) and carries where it came from. Nothing is generated here.

export interface StoredMeetingSummary {
  discussion?: string[];
  decisions?: string[];
  promises?: { text: string; by?: "me" | "them" }[];
  /** transcript-derived suggestions written by recording.suggestFromTranscript */
  ai?: { summary?: string | null; provenance?: string | null; recordingId?: string | null } | null;
}

export interface PriorMeetingRow {
  id: string;
  title: string;
  startedAt: Date | string | null;
  createdAt: Date | string;
  summary: StoredMeetingSummary | null;
}

export interface TranscriptLine {
  id: string;
  text: string;
}

export interface PriorMeetingFacts {
  meetingId: string;
  title: string;
  at: string;
  /** user-confirmed meeting card content */
  decisions: string[];
  promises: { text: string; by: "me" | "them" }[];
  discussion: string[];
  /** stored transcript summary — labelled with its provenance (AI 추론 / rules), never presented as the user's own note */
  transcriptSummary: { text: string; provenance: "ai_inferred" | "rules"; recordingId: string | null } | null;
  /** verbatim transcript lines, only when nothing else was stored for that meeting */
  transcriptExcerpt: { segmentId: string; text: string }[];
  source: "meeting_card";
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const clean = (xs: unknown, n: number): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, n) : []);

/** Facts of the most recent earlier meeting with this person, taken only from what was stored for it. */
export function priorMeetingFacts(m: PriorMeetingRow, transcript: TranscriptLine[] = [], max = 5): PriorMeetingFacts {
  const s = m.summary ?? {};
  const promises = (Array.isArray(s.promises) ? s.promises : [])
    .filter((p) => p && typeof p.text === "string" && p.text.trim())
    .slice(0, max)
    .map((p) => ({ text: p.text, by: p.by === "them" ? ("them" as const) : ("me" as const) }));
  const aiText = typeof s.ai?.summary === "string" && s.ai.summary.trim() ? s.ai.summary.trim() : null;
  const transcriptSummary = aiText ? { text: aiText, provenance: s.ai?.provenance === "ai_inferred" ? ("ai_inferred" as const) : ("rules" as const), recordingId: s.ai?.recordingId ?? null } : null;
  const decisions = clean(s.decisions, max);
  const discussion = clean(s.discussion, max);
  const nothingStored = !decisions.length && !discussion.length && !promises.length && !transcriptSummary;
  return {
    meetingId: m.id,
    title: m.title,
    at: iso(m.startedAt ?? m.createdAt),
    decisions,
    promises,
    discussion,
    transcriptSummary,
    transcriptExcerpt: nothingStored ? transcript.filter((t) => t.text.trim()).slice(0, 3).map((t) => ({ segmentId: String(t.id), text: t.text })) : [],
    source: "meeting_card",
  };
}

export interface FieldHistoryRow {
  field: string;
  old_value: string | null;
  new_value: string | null;
  source: string;
  changed_at: Date | string;
}

export interface PendingLivingUpdate {
  changes: { field: string; from: string | null; to: string | null }[];
  created_at: Date | string;
}

export interface ProfileChangeFact {
  field: string;
  from: string | null;
  to: string | null;
  at: string;
  /** contact_history = already applied to my contact record; linked_profile = their Living Card changed (pending my review) */
  source: "contact_history" | "linked_profile";
  /** for contact_history: who made the change (user edit / Living Update sync / …) */
  origin: string;
}

/**
 * Recent changes since `since`, newest first, one entry per field (the latest wins). Pending Living Update suggestions
 * from the person's own (ACL-filtered) Living Card are listed as linked_profile changes.
 */
export function recentProfileChanges(history: FieldHistoryRow[], pending: PendingLivingUpdate[], since: Date, limit = 6): ProfileChangeFact[] {
  const out: ProfileChangeFact[] = [];
  for (const h of history) {
    if (new Date(h.changed_at).getTime() < since.getTime()) continue;
    if (h.old_value === h.new_value) continue;
    out.push({ field: h.field, from: h.old_value, to: h.new_value, at: iso(h.changed_at), source: "contact_history", origin: h.source });
  }
  for (const p of pending) {
    for (const c of p.changes ?? []) {
      if (c.from === c.to) continue;
      out.push({ field: c.field, from: c.from ?? null, to: c.to ?? null, at: iso(p.created_at), source: "linked_profile", origin: "living_update" });
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(`${x.source}:${x.field}`) ? false : (seen.add(`${x.source}:${x.field}`), true))).slice(0, limit);
}
