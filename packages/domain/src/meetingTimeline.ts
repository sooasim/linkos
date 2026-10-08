// UX-015 녹음 마커 타임라인 + F-090 녹음 동의 정책 기본값 (pure, no I/O).

export interface TimelineSegment {
  id: string;
  recordingId?: string | null;
  startMs: number;
}
export interface TimelineMarker {
  id: string;
  recordingId: string | null;
  offsetMs: number;
  label: string | null;
}
export type TimelineItem<S extends TimelineSegment, M extends TimelineMarker> = { kind: "segment"; at: number; item: S } | { kind: "marker"; at: number; item: M };

/**
 * Interleave markers into the transcript by (recording order, time). A marker sorts before a segment that starts at
 * the same millisecond (it was dropped "at" that moment). Markers whose recording is unknown go last, by time.
 */
export function interleaveMarkers<S extends TimelineSegment, M extends TimelineMarker>(segments: S[], markers: M[], recordingOrder: string[] = []): TimelineItem<S, M>[] {
  const order = new Map<string, number>();
  for (const id of recordingOrder) if (!order.has(id)) order.set(id, order.size);
  for (const s of segments) if (s.recordingId && !order.has(s.recordingId)) order.set(s.recordingId, order.size);
  const rank = (rid: string | null | undefined) => (rid && order.has(rid) ? order.get(rid)! : Number.MAX_SAFE_INTEGER);
  const items: TimelineItem<S, M>[] = [
    ...segments.map((s) => ({ kind: "segment" as const, at: s.startMs, item: s })),
    ...markers.map((m) => ({ kind: "marker" as const, at: m.offsetMs, item: m })),
  ];
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => {
      const ra = rank(a.x.item.recordingId);
      const rb = rank(b.x.item.recordingId);
      if (ra !== rb) return ra - rb;
      if (a.x.at !== b.x.at) return a.x.at - b.x.at;
      if (a.x.kind !== b.x.kind) return a.x.kind === "marker" ? -1 : 1;
      return a.i - b.i;
    })
    .map((v) => v.x);
}

export type RecordingConsentPolicy = "all_party" | "one_party_notice";

/**
 * F-090: which consent policy the meeting screen preselects, and whether the user may change it.
 * Organization policy (`requireAllPartyRecordingConsent`) locks all-party consent; otherwise the meeting's
 * previously recorded policy, else the safe default all_party (one-party notice is opt-in where lawful).
 */
export function recordingPolicyDefault(opts: { orgRequiresAllParty?: boolean; current?: string | null }): { policy: RecordingConsentPolicy; locked: boolean; source: "org" | "meeting" | "default" } {
  if (opts.orgRequiresAllParty) return { policy: "all_party", locked: true, source: "org" };
  if (opts.current === "all_party" || opts.current === "one_party_notice") return { policy: opts.current, locked: false, source: "meeting" };
  return { policy: "all_party", locked: false, source: "default" };
}
