"use client";
// F-087 일정 후보 · F-108 일정 승인 · F-157 Room 미팅 · ICS 폴백. 후보는 승인 전까지 캘린더에 반영되지 않는다.
import { useState } from "react";
import { AiLabel } from "@/components/Page";
import { Icon } from "@/components/Icon";
import { api, uid } from "@/lib/client";

export interface Candidate {
  id: string;
  source: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  provenance: string;
  confidence: number | null;
  sourceText: string | null;
  attendees: { email: string; name?: string | null }[];
  requester: { name: string | null; email: string } | null;
  note: string | null;
  calendarEvent: { id: string; url: string | null } | null;
  icsUrl: string;
  conflictsWithCalendar?: boolean;
}

export function fmtSlot(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const d = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(s);
  const t = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(e);
  return `${d} – ${t}`;
}

const PROV: Record<string, string> = { ai_inferred: "AI 추론", rules: "메모에서 추출", guest: "게스트 요청", user: "직접 입력" };

export function CandidateCard({ c, onChange }: { c: Candidate; onChange: () => void }) {
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<any>(`/calendar/candidates/${c.id}/decision`, { body: { approve, notifyAttendees: notify }, idempotencyKey: uid() });
      if (approve) setMsg(r.calendarSync?.provider ? (r.calendarSync.status === "done" ? "캘린더에 등록했어요." : `캘린더 동기화: ${r.calendarSync.status}${r.calendarSync.error ? ` (${r.calendarSync.error})` : ""}`) : "확정했어요. 캘린더가 연결되지 않아 .ics 파일로 추가하세요.");
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = c.status === "proposed" || c.status === "pending_approval";
  return (
    <li className="surface space-y-2 p-4" data-testid="candidate">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{fmtSlot(c.startsAt, c.endsAt)}</span>
        {c.provenance === "ai_inferred" ? <AiLabel /> : <span className="chip">{PROV[c.provenance] ?? c.provenance}</span>}
        {c.confidence != null && c.provenance !== "user" && <span className="text-[12px] text-[var(--fg-mute)]">확신도 {Math.round(c.confidence * 100)}%</span>}
        {c.status === "approved" && <span className="chip !bg-[var(--fg)] !text-[var(--bg)]">확정</span>}
        {c.conflictsWithCalendar && <span className="chip !text-[var(--color-ember)]">캘린더 일정과 겹침</span>}
      </div>
      <p className="text-[14.5px]">{c.title}</p>
      {c.sourceText && <p className="text-[13px] text-[var(--fg-mute)]">근거: “{c.sourceText}”</p>}
      {c.requester && <p className="text-[13px]">요청자 {c.requester.name} · {c.requester.email}{c.note ? ` · ${c.note}` : ""}</p>}
      {c.attendees.length > 0 && <p className="text-[13px] text-[var(--fg-mute)]">참석자 {c.attendees.map((a) => a.name ?? a.email).join(", ")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {open && (
          <>
            <button className="btn btn-signal !min-h-9 text-[13px]" disabled={busy} onClick={() => decide(true)}><Icon name="check" size={15} />승인</button>
            <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => decide(false)}>거절</button>
            {c.attendees.length > 0 && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="size-4" checked={notify} onChange={(e) => setNotify(e.target.checked)} />참석자에게 초대 보내기</label>}
          </>
        )}
        {c.status === "approved" && <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={() => api(`/calendar/candidates/${c.id}`, { method: "DELETE" }).then(onChange)}>일정 취소</button>}
        <a className="btn btn-ghost !min-h-9 text-[13px]" href={c.icsUrl}><Icon name="download" size={15} />.ics</a>
        {c.calendarEvent?.url && <a className="text-[13px] underline" href={c.calendarEvent.url} target="_blank" rel="noopener noreferrer">캘린더에서 보기</a>}
      </div>
      {msg && <p className="text-[13px]" role="status">{msg}</p>}
    </li>
  );
}

/** Up to 3 datetime-local slots → ISO slots. */
export function SlotPicker({ onSubmit, cta, busy }: { onSubmit: (slots: { startsAt: string; endsAt: string }[]) => void; cta: string; busy?: boolean }) {
  const [vals, setVals] = useState<string[]>([""]);
  const [dur, setDur] = useState(30);
  const slots = vals.filter(Boolean).map((v) => {
    const s = new Date(v);
    return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + dur * 60000).toISOString() };
  });
  return (
    <div className="space-y-2">
      {vals.map((v, i) => (
        <input key={i} type="datetime-local" className="field" value={v} aria-label={`후보 ${i + 1}`} onChange={(e) => setVals(vals.map((x, j) => (j === i ? e.target.value : x)))} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {vals.length < 3 && <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => setVals([...vals, ""])}><Icon name="plus" size={15} />시간 추가</button>}
        <select className="field !min-h-9 !w-auto text-[13px]" value={dur} onChange={(e) => setDur(Number(e.target.value))} aria-label="길이">
          {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m}분</option>)}
        </select>
        <button className="btn btn-signal !min-h-9 text-[13px]" disabled={!slots.length || busy} onClick={() => onSubmit(slots)}>{cta}</button>
      </div>
    </div>
  );
}
