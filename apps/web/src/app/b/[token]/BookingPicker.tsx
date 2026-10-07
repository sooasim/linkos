"use client";
import { useMemo, useState } from "react";

interface Slot {
  startsAt: string;
  endsAt: string;
}

export function BookingPicker({ token, slots, timezone }: { token: string; slots: Slot[]; timezone: string }) {
  const viewerTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots) {
      const k = new Intl.DateTimeFormat("ko-KR", { timeZone: viewerTz, month: "long", day: "numeric", weekday: "short" }).format(new Date(s.startsAt));
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()];
  }, [slots, viewerTz]);
  const [day, setDay] = useState(0);
  const [pick, setPick] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ ics: string; startsAt: string } | null>(null);
  const time = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: viewerTz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pick) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/v1/booking/${encodeURIComponent(token)}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: pick.startsAt, name, email, note: note || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "예약하지 못했습니다.");
      setDone({ ics: data.ics, startsAt: data.startsAt });
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const href = `data:text/calendar;charset=utf-8,${encodeURIComponent(done.ics)}`;
    return (
      <section className="surface mt-8 space-y-3 p-5" role="status">
        <p className="text-[18px] font-semibold">요청을 보냈어요</p>
        <p className="text-[14.5px]">{new Intl.DateTimeFormat("ko-KR", { timeZone: viewerTz, dateStyle: "full", timeStyle: "short" }).format(new Date(done.startsAt))} — 상대가 승인하면 확정됩니다.</p>
        <a className="btn btn-ghost" href={href} download="linkos-meeting.ics">임시 일정(.ics) 받기</a>
      </section>
    );
  }
  if (!slots.length) return <p className="surface mt-8 p-5 text-[15px]">지금은 예약 가능한 시간이 없어요. 나중에 다시 확인해 주세요.</p>;
  const daySlots = byDay[day]?.[1] ?? [];
  return (
    <div className="mt-8 space-y-5">
      <div className="no-scrollbar flex gap-2 overflow-x-auto" role="tablist" aria-label="날짜">
        {byDay.map(([label], i) => (
          <button key={label} role="tab" aria-selected={i === day} onClick={() => { setDay(i); setPick(null); }} className={`chip shrink-0 ${i === day ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>{label}</button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {daySlots.map((s) => (
          <button key={s.startsAt} aria-pressed={pick?.startsAt === s.startsAt} onClick={() => setPick(s)} className={`btn !min-h-11 ${pick?.startsAt === s.startsAt ? "btn-signal" : "btn-ghost"}`}>{time(s.startsAt)}</button>
        ))}
      </div>
      {viewerTz !== timezone && <p className="text-[12.5px] text-[var(--fg-mute)]">내 시간대({viewerTz}) 기준으로 표시합니다.</p>}
      {pick && (
        <form onSubmit={submit} className="surface space-y-3 p-4">
          <p className="font-semibold">{time(pick.startsAt)} – {time(pick.endsAt)}</p>
          <input className="field" required maxLength={80} placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} aria-label="이름" autoComplete="name" />
          <input className="field" required type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="이메일" autoComplete="email" />
          <textarea className="field min-h-20" maxLength={1000} placeholder="미팅 주제 (선택)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="메모" />
          <p className="text-[12px] text-[var(--fg-mute)]">입력한 이름·이메일은 이 미팅 요청을 위해서만 상대에게 전달됩니다.</p>
          <button className="btn btn-signal btn-lg w-full" disabled={busy}>{busy ? "보내는 중…" : "이 시간으로 요청"}</button>
          {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
        </form>
      )}
    </div>
  );
}
