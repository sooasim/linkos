// F-082 전사 / F-083 화자분리 / F-084~F-086 근거 역추적: STT 결과 정규화, 화자별 세그먼트 묶기,
// 전사문에서 결정·약속·To-do 후보 추출(원문 문장 그대로, 세그먼트 ID 근거 포함), 추출 결과 ↔ 세그먼트 연결.

export interface SttWord {
  word: string;
  startMs: number;
  endMs: number;
  speaker?: string | null;
  confidence?: number | null;
}

export interface Segment {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface IdSegment {
  id: string | number;
  speaker?: string | null;
  text: string;
}

/** "1.250s" / "3s" / {seconds, nanos} → milliseconds (Google Duration JSON). */
export function durationToMs(d: unknown): number {
  if (typeof d === "number") return Math.round(d * 1000);
  if (typeof d === "string") {
    const m = d.trim().match(/^(-?\d+(?:\.\d+)?)s?$/);
    return m ? Math.round(Number(m[1]) * 1000) : 0;
  }
  if (d && typeof d === "object") {
    const o = d as { seconds?: string | number; nanos?: number };
    return Math.round(Number(o.seconds ?? 0) * 1000 + (o.nanos ?? 0) / 1e6);
  }
  return 0;
}

const joinWords = (ws: string[]) =>
  ws
    .join(" ")
    .replace(/\s+([,.!?;:。、，])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Group consecutive words of the same speaker into segments; split on long pauses or very long turns. */
export function groupWordsIntoSegments(words: SttWord[], opts: { maxGapMs?: number; maxSegmentMs?: number } = {}): Segment[] {
  const maxGap = opts.maxGapMs ?? 1500;
  const maxLen = opts.maxSegmentMs ?? 30_000;
  const out: Segment[] = [];
  let cur: { speaker: string | null; startMs: number; endMs: number; words: string[]; conf: number[] } | null = null;
  const flush = () => {
    if (cur && cur.words.length) {
      out.push({ speaker: cur.speaker, startMs: cur.startMs, endMs: cur.endMs, text: joinWords(cur.words), confidence: cur.conf.length ? Math.round((cur.conf.reduce((a, b) => a + b, 0) / cur.conf.length) * 1000) / 1000 : null });
    }
    cur = null;
  };
  for (const w of words) {
    const speaker = w.speaker ?? null;
    if (cur && (speaker !== cur.speaker || w.startMs - cur.endMs > maxGap || w.endMs - cur.startMs > maxLen)) flush();
    if (!cur) cur = { speaker, startMs: w.startMs, endMs: w.endMs, words: [], conf: [] };
    cur.words.push(w.word);
    cur.endMs = Math.max(cur.endMs, w.endMs);
    if (typeof w.confidence === "number") cur.conf.push(w.confidence);
  }
  flush();
  return out;
}

/** Shift segment times by the offset of the audio part they came from (parts are transcribed independently). */
export function offsetSegments(segs: Segment[], offsetMs: number): Segment[] {
  return segs.map((s) => ({ ...s, startMs: s.startMs + offsetMs, endMs: s.endMs + offsetMs }));
}

/** Most frequent non-empty language code (e.g. "ko-KR") — F-082 언어 감지. */
export function dominantLanguage(codes: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const c of codes) if (c) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

/** Plain-text transcript ("S1: …" lines) used as input for summarization. */
export function transcriptText(segs: { speaker?: string | null; text: string }[]): string {
  return segs.map((s) => `${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
}

// ---------------------------------------------------------------- evidence linking

function grams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const out = new Set<string>();
  for (const w of t.split(" ")) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) out.add(w);
    else for (let i = 0; i < Math.max(1, w.length - 1); i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** Overlap coefficient |A∩B| / min(|A|,|B|) on words (Latin) and character bigrams (CJK). */
export function evidenceScore(claim: string, segment: string): number {
  const A = grams(claim);
  const B = grams(segment);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Segment ids that support `claim`: the best match plus any other strong matches (≤ 3), above `min`. */
export function linkEvidence(claim: string, segments: IdSegment[], min = 0.5): (string | number)[] {
  const scored = segments.map((s) => ({ id: s.id, score: evidenceScore(claim, s.text) })).filter((s) => s.score >= min);
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0]!.score;
  return scored.filter((s) => s.score >= Math.max(min, top - 0.15)).slice(0, 3).map((s) => s.id);
}

// ---------------------------------------------------------------- rule-based commitments

export interface GroundedItem {
  text: string;
  segmentIds: (string | number)[];
  speaker: string | null;
}

export interface TranscriptCommitments {
  decisions: GroundedItem[];
  actionItems: (GroundedItem & { dueHint: string })[];
  promises: GroundedItem[];
}

const DECISION_RE = /(결정|합의|확정|하기로\s*(?:했|하였|합의|결정)|진행하기로|가기로|decided|agreed|we(?:'ll| will) go with|let'?s go with)/i;
const COMMIT_RE = /(드리겠습니다|드릴게요|드릴께요|보내\s*드리|공유\s*드리|전달\s*드리|하겠습니다|할게요|할께요|준비하겠|정리해서|챙기겠|I(?:'ll| will)\s+\w+|we(?:'ll| will)\s+(?:send|share|prepare|follow|get back)|will send|will share|follow up)/i;
const DUE_RE = /(\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일|오늘|내일|모레|이번\s*주(?:\s*[월화수목금토일]요일)?|다음\s*주(?:\s*[월화수목금토일]요일)?|[월화수목금토일]요일|주말|월말|by\s+(?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week|eod|end of (?:day|week)))/i;
const QUESTION_RE = /[?？]\s*$|(할까요|될까요|인가요|있나요|건가요)\s*[.?]?$/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|(?<=(?:니다|어요|아요|해요|세요|죠|요)[.!]?)\s+(?=\S)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/**
 * Deterministic fallback for transcripts (no LLM): sentences with decision / commitment cues.
 * Every returned text is a verbatim sentence of a segment, with that segment's id as evidence.
 */
export function extractCommitments(segments: IdSegment[]): TranscriptCommitments {
  const out: TranscriptCommitments = { decisions: [], actionItems: [], promises: [] };
  const seen = new Set<string>();
  for (const seg of segments) {
    for (const s of sentences(seg.text)) {
      if (seen.has(s) || QUESTION_RE.test(s)) continue;
      const base = { text: s, segmentIds: [seg.id], speaker: seg.speaker ?? null };
      if (DECISION_RE.test(s)) {
        out.decisions.push(base);
        seen.add(s);
      } else if (COMMIT_RE.test(s)) {
        const due = s.match(DUE_RE);
        out.actionItems.push({ ...base, dueHint: due?.[1] ?? "" });
        out.promises.push(base);
        seen.add(s);
      }
    }
  }
  return out;
}
