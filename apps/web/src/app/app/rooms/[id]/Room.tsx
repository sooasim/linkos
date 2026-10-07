"use client";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/Page";
import { RoomFiles } from "@/components/RoomFiles";
import { api, relTime } from "@/lib/client";

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
