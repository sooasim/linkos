"use client";
// F-082 전사 / F-083 화자분리 / F-084~F-086 요약·To-do·약속 제안 + 근거 역추적:
// 제안이나 To-do 를 누르면 근거가 된 전사 구간이 강조되고 그 위치로 이동한다. 제안은 "AI 추론/규칙 추출" 라벨과 함께
// 사용자가 확인(→ To-do)하거나 무시할 때까지 저장된 To-do 가 아니다(F-102).
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel } from "@/components/Page";
import { api, fmtDate } from "@/lib/client";

type Seg = { id: string; speaker: string | null; startMs: number; endMs: number; text: string; confidence: number | null };
type Rec = { id: string; status: string; parts: number; partsDone: number; partsFailed: number; language: string | null; provider: string | null; error: string | null; createdAt: string };
type Evid = { text: string; segmentIds: string[] };

const ts = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const STATUS: Record<string, string> = { recording: "녹음 중", transcribing: "전사 중", transcribed: "분석 중", analyzed: "전사 완료", stored: "저장됨(전사 미설정)", empty: "빈 녹음" };
const SPEAKER_TONES = ["bg-[var(--color-signal)] text-[var(--color-ink)]", "bg-[var(--color-ember)] text-white", "bg-[var(--fg)] text-[var(--bg)]", "bg-[var(--bg-elev)] text-[var(--fg)]"];

export function TranscriptPanel({
  meetingId,
  refreshKey,
  confirmed,
  onAccepted,
  onApplyDecision,
  onUseTranscript,
}: {
  meetingId: string;
  refreshKey: number;
  confirmed: { id?: string; description: string; sourceSegmentIds?: string[] }[];
  onAccepted: (a: { id: string; description: string; dueAt: string | null; sourceSegmentIds: string[] }) => void;
  onApplyDecision: (kind: "decision" | "promise", text: string) => void;
  onUseTranscript: (text: string) => void;
}) {
  const [t, setT] = useState<{ recordings: Rec[]; segments: Seg[] } | null>(null);
  const [m, setM] = useState<{ suggestedActions: any[]; ai: any } | null>(null);
  const [hl, setHl] = useState<Set<string>>(new Set());
  const list = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    const [tr, mt] = await Promise.all([api(`/meetings/${meetingId}/transcript`), api(`/meetings/${meetingId}`)]);
    setT(tr);
    setM({ suggestedActions: mt.suggestedActions ?? [], ai: mt.ai ?? null });
    return tr as { recordings: Rec[] };
  }, [meetingId]);

  useEffect(() => {
    let timer: number | null = null;
    let alive = true;
    const tick = async () => {
      const tr = await load().catch(() => null);
      if (alive && tr?.recordings.some((r) => ["recording", "transcribing", "transcribed"].includes(r.status))) timer = window.setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [load, refreshKey]);

  const show = (ids: string[]) => {
    setHl(new Set(ids));
    const first = ids[0] && list.current?.querySelector(`[data-seg="${ids[0]}"]`);
    if (first) (first as HTMLElement).scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const decide = async (a: any, accept: boolean) => {
    await api(`/meetings/${meetingId}/actions/${a.id}/confirm`, { body: { accept }, offline: false });
    if (accept) onAccepted({ id: a.id, description: a.description, dueAt: null, sourceSegmentIds: a.sourceSegmentIds });
    await load();
  };

  if (!t) return null;
  if (!t.recordings.length && !t.segments.length) return null;
  const speakers = [...new Set(t.segments.map((s) => s.speaker ?? "?"))];
  const tone = (sp: string | null) => SPEAKER_TONES[speakers.indexOf(sp ?? "?") % SPEAKER_TONES.length];
  const evidenced = confirmed.filter((a) => a.sourceSegmentIds?.length);
  const label = (prov: string) => (prov === "ai_inferred" ? "AI 추론 · 확인 필요" : "전사에서 규칙 추출 · 확인 필요");

  return (
    <section className="surface space-y-4 p-5" aria-label="전사">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold">전사 · 화자 분리</h2>
        <div className="flex flex-wrap gap-1.5">
          {t.recordings.map((r) => (
            <span key={r.id} className="chip !text-[12px]" title={r.error ?? undefined}>
              {fmtDate(r.createdAt, { hour: "2-digit", minute: "2-digit" })} · {STATUS[r.status] ?? r.status}
              {r.status === "transcribing" ? ` ${r.partsDone}/${r.parts}` : ""}
              {r.language ? ` · ${r.language}` : ""}
            </span>
          ))}
        </div>
      </div>

      {m && (m.suggestedActions.length > 0 || m.ai) && (
        <div className="space-y-3 rounded-2xl border border-[var(--line)] p-4" data-testid="transcript-suggestions">
          {m.ai?.summary && (
            <div>
              <AiLabel>{label(m.ai.provenance)}</AiLabel>
              <p className="mt-1 text-[14.5px]">{m.ai.summary}</p>
            </div>
          )}
          {m.suggestedActions.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 text-[14.5px]">
              <button type="button" className="min-w-0 flex-1 text-left underline-offset-4 hover:underline" onClick={() => show(a.sourceSegmentIds)} aria-label={`근거 보기: ${a.description}`}>
                <span className="text-[12px] font-semibold text-[var(--fg-mute)]">To-do 제안 · </span>
                {a.description}
                {a.dueHint ? <span className="text-[var(--fg-mute)]"> ({a.dueHint})</span> : null}
                {a.sourceSegmentIds.length ? <span className="ml-1 text-[12px] text-[var(--fg-mute)]">근거 {a.sourceSegmentIds.length}</span> : null}
              </button>
              <AiLabel>{a.provenance === "ai_inferred" ? "AI 추론" : "규칙"}</AiLabel>
              <button type="button" className="btn btn-signal !min-h-9 !px-3" onClick={() => decide(a, true)}>확인</button>
              <button type="button" className="btn btn-ghost !min-h-9 !px-3" onClick={() => decide(a, false)} aria-label={`무시: ${a.description}`}>무시</button>
            </div>
          ))}
          {(m.ai?.decisions ?? []).map((d: Evid) => (
            <div key={`d-${d.text}`} className="flex flex-wrap items-center gap-2 text-[14.5px]">
              <button type="button" className="min-w-0 flex-1 text-left underline-offset-4 hover:underline" onClick={() => show(d.segmentIds)}>
                <span className="text-[12px] font-semibold text-[var(--fg-mute)]">결정 제안 · </span>{d.text}
              </button>
              <button type="button" className="btn btn-ghost !min-h-9 !px-3" onClick={() => onApplyDecision("decision", d.text)}>카드에 적용</button>
            </div>
          ))}
          {(m.ai?.promises ?? []).map((p: Evid) => (
            <div key={`p-${p.text}`} className="flex flex-wrap items-center gap-2 text-[14.5px]">
              <button type="button" className="min-w-0 flex-1 text-left underline-offset-4 hover:underline" onClick={() => show(p.segmentIds)}>
                <span className="text-[12px] font-semibold text-[var(--fg-mute)]">약속 제안 · </span>{p.text}
              </button>
              <button type="button" className="btn btn-ghost !min-h-9 !px-3" onClick={() => onApplyDecision("promise", p.text)}>카드에 적용</button>
            </div>
          ))}
        </div>
      )}

      {evidenced.length > 0 && (
        <div className="space-y-1">
          <p className="eyebrow">확정된 To-do 근거</p>
          {evidenced.map((a) => (
            <button key={a.id ?? a.description} type="button" className="flex items-center gap-2 text-left text-[14px] underline-offset-4 hover:underline" onClick={() => show(a.sourceSegmentIds!)}>
              <Icon name="check" size={14} /> {a.description}
            </button>
          ))}
        </div>
      )}

      {t.segments.length > 0 ? (
        <>
          <ol ref={list} className="max-h-[420px] space-y-2 overflow-y-auto pr-1" aria-label="전사문">
            {t.segments.map((s) => (
              <li key={s.id} data-seg={s.id} className={`rounded-xl px-3 py-2 text-[14.5px] transition-colors motion-reduce:transition-none ${hl.has(s.id) ? "bg-[var(--color-signal)]/35 ring-2 ring-[var(--color-signal)]" : ""}`} aria-current={hl.has(s.id) ? "true" : undefined}>
                <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${tone(s.speaker)}`}>{s.speaker ?? "화자"}</span>
                <span className="num mr-2 text-[12px] text-[var(--fg-mute)]">{ts(s.startMs)}</span>
                {s.text}
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-ghost" onClick={() => onUseTranscript(t.segments.map((s) => `${s.speaker ?? ""}: ${s.text}`).join("\n"))}>
            전사문으로 자동 정리하기
          </button>
        </>
      ) : (
        <p className="text-[13.5px] text-[var(--fg-mute)]">아직 전사된 문장이 없어요.</p>
      )}
    </section>
  );
}
