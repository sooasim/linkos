"use client";
// F-157 미팅 예약 — Connection Room 공동 일정: 후보 제안 → 양측 확인 후 하나 승인 → 캘린더/ICS
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { type Candidate, CandidateCard, SlotPicker } from "@/components/Scheduling";
import { api } from "@/lib/client";

export function RoomMeeting({ roomId }: { roomId: string }) {
  const [cands, setCands] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ candidates: Candidate[] }>(`/rooms/${roomId}/meetings`).then((r) => setCands(r.candidates)).catch(() => undefined), [roomId]);
  useEffect(() => {
    load();
  }, [load]);
  const propose = async (slots: { startsAt: string; endsAt: string }[]) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/rooms/${roomId}/meetings`, { body: { slots, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      setMsg("후보를 기록했어요. 두 분께 가능한 시간을 확인한 뒤 하나를 승인하세요.");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface mt-6 space-y-3 p-5" aria-label="미팅 예약">
      <h2 className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="calendar" size={18} />소개 미팅 잡기</h2>
      {cands.length > 0 && <ul className="space-y-2">{cands.map((c) => <CandidateCard key={c.id} c={c} onChange={load} />)}</ul>}
      <SlotPicker cta="후보 제안" busy={busy} onSubmit={propose} />
      {msg && <p className="text-[13.5px]" role="status">{msg}</p>}
    </section>
  );
}
