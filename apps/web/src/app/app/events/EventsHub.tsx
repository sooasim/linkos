"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { api } from "@/lib/client";

export function EventsHub() {
  const [events, setEvents] = useState<any[] | null>(null);
  const [form, setForm] = useState({ name: "", venue: "" });
  const [join, setJoin] = useState({ code: "", optIn: true });
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<{ events: any[] }>("/events").then((r) => setEvents(r.events));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-2">
        <form className="surface space-y-3 p-5" onSubmit={async (e) => { e.preventDefault(); await api("/events", { body: { name: form.name, venue: form.venue || null } }); setForm({ name: "", venue: "" }); load(); }}>
          <h2 className="font-semibold">행사 만들기</h2>
          <input className="field" placeholder="행사 이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input className="field" placeholder="장소" value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          <button className="btn btn-signal w-full">만들기</button>
        </form>
        <form className="surface space-y-3 p-5" onSubmit={async (e) => { e.preventDefault(); setMsg(null); try { await api("/events/join", { body: { joinCode: join.code, optIn: join.optIn } }); load(); setJoin({ ...join, code: "" }); } catch (err) { setMsg((err as Error).message); } }}>
          <h2 className="font-semibold">참가 코드로 입장</h2>
          <input className="field num uppercase tracking-[0.3em]" placeholder="ABC234" maxLength={8} value={join.code} onChange={(e) => setJoin({ ...join, code: e.target.value.toUpperCase() })} required />
          <label className="flex items-start gap-2 text-[13.5px]"><input type="checkbox" className="mt-0.5 size-4" checked={join.optIn} onChange={(e) => setJoin({ ...join, optIn: e.target.checked })} />다른 참가자에게 내 Offer/Need 기반 추천 노출에 동의 (나중에 변경 가능)</label>
          <button className="btn btn-ink w-full">입장</button>
          {msg && <p className="text-[13px] text-[var(--color-ember)]">{msg}</p>}
        </form>
      </section>
      <section>
        <h2 className="mb-3 text-[18px] font-semibold">내 행사</h2>
        {!events ? <div className="surface h-24 animate-pulse" /> : events.length === 0 ? <Empty title="참여한 행사가 없어요" /> : (
          <ul className="space-y-2">
            {events.map((e) => (
              <li key={e.id}>
                <Link href={`/app/events/${e.id}`} className="surface flex items-center gap-4 p-4">
                  <Icon name="flag" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{e.name}</span>
                    <span className="block text-[13px] text-[var(--fg-mute)]">{e.venue ?? ""} · 참가 {e.attendees} · 내 리드 {e.my_leads}</span>
                  </span>
                  {e.is_owner && <span className="chip num">{e.join_code}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
