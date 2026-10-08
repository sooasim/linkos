"use client";
import { useEffect, useState } from "react";
import { AiLabel, PageHeader } from "@/components/Page";
import { RoomFiles } from "@/components/RoomFiles";
import { api, relTime } from "@/lib/client";

// F-158 Room 요약 (진행 상태 / 결정 / 미완료 작업) — suggestion only
function RoomSummary({ id, initial }: { id: string; initial: any }) {
  const [s, setS] = useState<any>(initial);
  const [busy, setBusy] = useState(false);
  return (
    <section className="surface mt-4 space-y-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">Room 요약 {s && s.provenance === "ai_inferred" && <AiLabel />}</p>
        <button className="btn btn-ghost !min-h-9 text-[13px]" disabled={busy} onClick={async () => { setBusy(true); setS((await api<{ summary: any }>(`/rooms/${id}/summary`, { body: {} })).summary); setBusy(false); }}>{busy ? "요약 중…" : s ? "다시 요약" : "요약하기"}</button>
      </div>
      {s && (
        <div className="space-y-1.5 text-[14px]">
          <p>{s.status}</p>
          {s.decisions?.length > 0 && <p><b>결정</b> · {s.decisions.join(" / ")}</p>}
          {s.openItems?.length > 0 && <p><b>미완료</b> · {s.openItems.join(" / ")}</p>}
          {s.nextStep && <p><b>다음</b> · {s.nextStep}</p>}
          <p className="text-[12px] text-[var(--fg-mute)]">{s.provenance === "rules" ? "기록에 '결정:', '할 일:' 로 적힌 내용만 정리했어요." : "AI 요약은 확인 후 사용하세요."}</p>
        </div>
      )}
    </section>
  );
}

export function Room({ id }: { id: string }) {
  const [r, setR] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [next, setNext] = useState("");
  const load = () => api(`/rooms/${id}`).then((x) => { setR(x); setNext(x.nextAction ?? ""); });
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <div className="surface h-40 animate-pulse" />;
  return (
    <div>
      <PageHeader back="/app/intros" eyebrow={r.status === "won" ? "성사" : "Connection Room"} title={r.introduction ? <>{r.introduction.partyA.name} <em>&</em> {r.introduction.partyB.name}</> : r.title} />
      <section className="surface p-4">
        <p className="eyebrow">소개 이유</p>
        <p className="mt-1">{r.purpose}</p>
      </section>
      <section className="mt-4 flex gap-2">
        <input className="field" placeholder="Next Action" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="btn btn-ink shrink-0" onClick={() => api(`/rooms/${id}`, { method: "PATCH", body: { nextAction: next } }).then(load)}>저장</button>
        <button className="btn btn-signal shrink-0" onClick={() => api(`/rooms/${id}`, { method: "PATCH", body: { status: "won" } }).then(load)}>성사</button>
      </section>
      <RoomSummary id={id} initial={r.summary ?? null} />
      <RoomFiles roomId={id} onChange={load} />
      <ul className="mt-6 space-y-3">
        {r.messages.map((m: any) => (
          <li key={m.id} className="surface p-4">
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className="mt-1 text-[12px] text-[var(--fg-mute)]">{relTime(m.created_at)}</p>
          </li>
        ))}
      </ul>
      <form className="mt-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!msg.trim()) return; await api(`/rooms/${id}/messages`, { body: { body: msg } }); setMsg(""); load(); }}>
        <input className="field" placeholder="자료, 메모, 진행 상황" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="btn btn-signal shrink-0">기록</button>
      </form>
    </div>
  );
}
