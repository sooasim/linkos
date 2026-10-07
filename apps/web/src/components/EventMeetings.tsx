"use client";
// F-146 행사 미팅 요청 — 추천 노출에 동의한 참가자에게 1:1 미팅 요청, 수락 시 양쪽 일정 확정(캘린더/ICS)
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { fmtSlot, SlotPicker } from "@/components/Scheduling";
import { api } from "@/lib/client";

export function EventMeetings({ eventId }: { eventId: string }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ requests: any[] }>(`/events/${eventId}/meeting-requests`).then((r) => setRequests(r.requests)).catch(() => undefined), [eventId]);
  useEffect(() => {
    load();
    api<{ results: any[] }>(`/events/${eventId}/matches`).then((r) => setMatches(r.results)).catch(() => undefined);
  }, [eventId, load]);
  const request = async (slots: { startsAt: string; endsAt: string }[]) => {
    setMsg(null);
    try {
      await api(`/events/${eventId}/meeting-requests`, { body: { targetProfileId: target, slots, message: message || undefined } });
      setTarget(null);
      setMessage("");
      setMsg("요청을 보냈어요. 상대가 시간을 고르면 확정됩니다.");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const respond = async (id: string, accept: boolean, slotIndex = 0) => {
    await api(`/event-meeting-requests/${id}`, { body: { accept, slotIndex } }).catch((e) => setMsg((e as Error).message));
    load();
  };
  const incoming = requests.filter((r) => r.direction === "incoming");
  const outgoing = requests.filter((r) => r.direction === "outgoing");
  return (
    <section className="mt-8 space-y-3" aria-label="1:1 미팅">
      <h2 className="text-[18px] font-semibold">현장 1:1 미팅</h2>
      {incoming.map((r) => (
        <div key={r.id} className="surface space-y-2 p-4 text-[14px]">
          <p><b>{r.counterpart.name}</b>{r.counterpart.company ? ` · ${r.counterpart.company}` : ""}님의 요청{r.status !== "pending" ? ` · ${r.status === "accepted" ? "수락함" : r.status === "declined" ? "거절함" : "취소됨"}` : ""}</p>
          {r.message && <p className="text-[var(--fg-mute)]">“{r.message}”</p>}
          {r.status === "pending" ? (
            <div className="flex flex-wrap gap-2">
              {r.slots.map((s: any, i: number) => <button key={s.startsAt} className="btn btn-signal !min-h-9 text-[13px]" onClick={() => respond(r.id, true, i)}><Icon name="check" size={14} />{fmtSlot(s.startsAt, s.endsAt)}</button>)}
              <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => respond(r.id, false)}>거절</button>
            </div>
          ) : r.accepted && <p>{fmtSlot(r.accepted.startsAt, r.accepted.endsAt)}</p>}
        </div>
      ))}
      {outgoing.map((r) => (
        <div key={r.id} className="surface flex flex-wrap items-center justify-between gap-2 p-4 text-[14px]">
          <span>{r.counterpart.name}님께 요청 · {r.status === "pending" ? "응답 대기" : r.status === "accepted" ? `확정 ${fmtSlot(r.accepted.startsAt, r.accepted.endsAt)}` : r.status === "declined" ? "거절됨" : "취소"}</span>
          {r.status === "pending" && <button className="text-[13px] text-[var(--color-ember)]" onClick={() => api(`/event-meeting-requests/${r.id}`, { method: "DELETE" }).then(load)}>요청 취소</button>}
        </div>
      ))}
      {matches.length > 0 && (
        <div className="surface space-y-2 p-4">
          <label className="label" htmlFor="emr-target">미팅을 요청할 사람</label>
          <select id="emr-target" className="field" value={target ?? ""} onChange={(e) => setTarget(e.target.value || null)}>
            <option value="">선택…</option>
            {matches.map((m) => <option key={m.candidateId} value={m.candidateId}>{m.candidateName}{m.company ? ` · ${m.company}` : ""}</option>)}
          </select>
          {target && (
            <>
              <input className="field" placeholder="한 줄 메시지 (선택)" maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="메시지" />
              <SlotPicker cta="요청 보내기" onSubmit={request} />
            </>
          )}
        </div>
      )}
      {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
    </section>
  );
}
