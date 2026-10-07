"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { BadgeLeadScanner } from "@/components/BadgeLeadScanner";
import { AiLabel, Avatar, Empty, PageHeader } from "@/components/Page";
import { api } from "@/lib/client";

export function EventDetail({ id }: { id: string }) {
  const [e, setE] = useState<any>(null);
  const [m, setM] = useState<any>(null);
  const reload = () => api(`/events/${id}`).then(setE).catch(() => undefined);
  useEffect(() => {
    reload();
    api(`/events/${id}/matches`).then(setM).catch(() => setM({ results: [] }));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // F-150: the badge scanner works even when the event could not be loaded (offline at the venue)
  if (!e) return <div className="space-y-4"><div className="surface h-40 animate-pulse" /><BadgeLeadScanner eventId={id} onSaved={reload} /></div>;
  return (
    <div>
      <PageHeader back="/app/events" eyebrow={e.venue ?? "Event"} title={e.name} />
      <div className="grid grid-cols-3 gap-3">
        {[["참가자", e.attendees], ["추천 공개", e.optedIn], ["내 리드", e.leads.length]].map(([l, v]) => (
          <div key={l} className="surface p-4"><p className="text-[12px] text-[var(--fg-mute)]">{l}</p><p className="display num text-[36px]">{v}</p></div>
        ))}
      </div>
      {e.isOwner && <p className="mt-4 text-[14px]">참가 코드 <b className="num tracking-[0.2em]">{e.joinCode}</b> — 참가자에게 공유하세요.</p>}
      <Link href={`/app/events/${id}/booth`} className="btn btn-ghost mt-4"><Icon name="flag" size={18} /> 부스 모드 · 리드 · ROI</Link>
      <section className="mt-8">
        <h2 className="mb-1 text-[18px] font-semibold">오늘 만나볼 사람</h2>
        <p className="mb-3 flex items-center gap-2 text-[13px] text-[var(--fg-mute)]"><AiLabel /> 추천 노출에 동의한 참가자만 · 공유한 Offer/Need 기반</p>
        {!m ? <div className="surface h-24 animate-pulse" /> : m.results.length === 0 ? <Empty title="아직 추천이 없어요" body="Offer/Need를 채운 참가자가 늘어나면 추천이 생겨요." /> : (
          <ul className="space-y-2">
            {m.results.map((r: any) => (
              <li key={r.candidateId} className="surface flex items-center gap-3 p-4">
                <Avatar name={r.candidateName} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{r.candidateName} <span className="font-normal text-[var(--fg-mute)]">{r.company ?? ""}</span></span>
                  <span className="block truncate text-[13px] text-[var(--fg-mute)]">{r.reasons[0]?.text}</span>
                </span>
                <span className="display num text-[28px]">{Math.round(r.score * 100)}</span>
                {r.slug && <Link href={`/p/${r.slug}`} aria-label="카드 보기"><Icon name="arrow" /></Link>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="mt-8">
        <BadgeLeadScanner eventId={id} onSaved={reload} />
      </section>
      <section className="mt-8">
        <h2 className="mb-3 text-[18px] font-semibold">이 행사에서 받은 명함</h2>
        {e.leads.length === 0 ? <Empty title="아직 없어요" body="교환 화면에서 장소를 이 행사로 적으면 리드로 모입니다." /> : (
          <ul className="surface divide-y divide-[var(--line)]">
            {e.leads.map((l: any) => <li key={l.contactId}><Link href={`/app/people/${l.contactId}`} className="flex items-center gap-3 px-4 py-3"><Avatar name={l.fullName} size={36} />{l.fullName}<span className="text-[13px] text-[var(--fg-mute)]">{l.company}</span></Link></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
