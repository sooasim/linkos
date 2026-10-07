"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/Page";
import { type Candidate, CandidateCard } from "@/components/Scheduling";
import { api, uid } from "@/lib/client";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function CalendarHub() {
  const [status, setStatus] = useState<{ provider: string | null } | null>(null);
  const [pending, setPending] = useState<Candidate[]>([]);
  const [approved, setApproved] = useState<Candidate[]>([]);
  const load = useCallback(() => {
    api("/calendar/status").then(setStatus).catch(() => undefined);
    Promise.all([api<{ candidates: Candidate[] }>("/calendar/candidates?status=pending_approval"), api<{ candidates: Candidate[] }>("/calendar/candidates?status=proposed")]).then(([a, b]) => setPending([...a.candidates, ...b.candidates]));
    api<{ candidates: Candidate[] }>("/calendar/candidates?status=approved").then((r) => setApproved(r.candidates.filter((c) => new Date(c.endsAt).getTime() > Date.now())));
  }, []);
  useEffect(load, [load]);
  const connect = async () => {
    const r = await api<{ url: string }>("/integrations/google/connect", { body: { purpose: "calendar" } });
    window.location.href = r.url;
  };

  return (
    <div className="space-y-6">
      <section className="surface flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-[14px]">
          {status?.provider ? <>캘린더 연결됨 · <b>{status.provider === "google" ? "Google Calendar" : "Outlook"}</b> — 승인한 일정만 등록됩니다.</> : "연결된 캘린더가 없어요. 확정한 일정은 .ics 파일로 내 캘린더에 추가할 수 있어요."}
        </p>
        {!status?.provider && <button className="btn btn-ink !min-h-10 text-[14px]" onClick={connect}><Icon name="calendar" size={16} />Google Calendar 연결</button>}
      </section>

      <section className="space-y-3">
        <h2 className="text-[18px] font-semibold">승인 대기</h2>
        {pending.length === 0 ? <Empty title="승인할 일정 후보가 없어요" body="미팅 카드의 ‘다음 일정’, 예약 링크, Connection Room에서 후보가 만들어집니다." /> : <ul className="space-y-2">{pending.map((c) => <CandidateCard key={c.id} c={c} onChange={load} />)}</ul>}
      </section>

      <section className="space-y-3">
        <h2 className="text-[18px] font-semibold">확정된 일정</h2>
        {approved.length === 0 ? <p className="text-[14px] text-[var(--fg-mute)]">다가오는 확정 일정이 없어요.</p> : <ul className="space-y-2">{approved.map((c) => <CandidateCard key={c.id} c={c} onChange={load} />)}</ul>}
      </section>

      <BookingPages />
    </div>
  );
}

function BookingPages() {
  const [pages, setPages] = useState<any[]>([]);
  const [form, setForm] = useState({ title: "30분 미팅", durationMin: 30, days: [1, 2, 3, 4, 5], start: "10:00", end: "17:00", minNoticeH: 4, horizonDays: 14, location: "" });
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => api<{ pages: any[] }>("/calendar/booking-pages").then((r) => setPages(r.pages));
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    setErr(null);
    try {
      await api("/calendar/booking-pages", {
        idempotencyKey: uid(),
        body: {
          title: form.title,
          durationMin: form.durationMin,
          minNoticeMin: form.minNoticeH * 60,
          horizonDays: form.horizonDays,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          location: form.location || null,
          windows: form.days.map((weekday) => ({ weekday, start: toMin(form.start), end: toMin(form.end) })),
        },
      });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  };
  return (
    <section className="space-y-3">
      <h2 className="text-[18px] font-semibold">예약 링크</h2>
      <p className="text-[13.5px] text-[var(--fg-mute)]">상대가 로그인 없이 내 빈 시간 중 하나를 고르면, 내가 승인한 뒤에 일정이 확정됩니다. {`Google 캘린더가 연결되어 있으면 바쁜 시간은 자동으로 빠져요.`}</p>
      <ul className="space-y-2">
        {pages.map((p) => (
          <li key={p.id} className="surface space-y-2 p-4 text-[14px]">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{p.title} · {p.durationMin}분</p>
              <span className="chip">{p.active ? "공개 중" : "꺼짐"}</span>
            </div>
            <p className="text-[13px] text-[var(--fg-mute)]">{p.windows.map((w: any) => `${DAYS[w.weekday]} ${toHm(w.start)}–${toHm(w.end)}`).join(" · ")} ({p.timezone})</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ink !min-h-9 text-[13px]" onClick={() => copy(p.url)}><Icon name="link" size={15} />{copied === p.url ? "복사됨" : "링크 복사"}</button>
              <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => api(`/calendar/booking-pages/${p.id}`, { method: "PATCH", body: { active: !p.active } }).then(load)}>{p.active ? "끄기" : "켜기"}</button>
              <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => confirm("기존 링크는 더 이상 열리지 않습니다. 새 링크를 만들까요?") && api(`/calendar/booking-pages/${p.id}`, { method: "PATCH", body: { rotateLink: true } }).then(load)}>링크 재발급</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="surface space-y-3 p-4">
        <p className="font-semibold">새 예약 링크</p>
        <input className="field" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="제목" />
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <button key={d} aria-pressed={form.days.includes(i)} className={`chip ${form.days.includes(i) ? "!bg-[var(--fg)] !text-[var(--bg)]" : ""}`} onClick={() => setForm({ ...form, days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })}>{d}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="text-[13px]">시작<input type="time" className="field" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
          <label className="text-[13px]">종료<input type="time" className="field" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          <label className="text-[13px]">길이(분)<select className="field" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })}>{[15, 30, 45, 60].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="text-[13px]">최소 예약 여유(시간)<input type="number" min={0} max={168} className="field" value={form.minNoticeH} onChange={(e) => setForm({ ...form, minNoticeH: Number(e.target.value) })} /></label>
        </div>
        <input className="field" placeholder="장소 / 화상회의 링크 (선택)" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} aria-label="장소" />
        <button className="btn btn-signal" disabled={!form.days.length || !form.title} onClick={create}>링크 만들기</button>
        {err && <p className="text-[13px] text-[var(--color-ember)]" role="alert">{err}</p>}
      </div>
    </section>
  );
}
