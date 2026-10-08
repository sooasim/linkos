"use client";
// UX-021 Event detail — F-141 행사 공간, F-143 현장 교환(이 행사로 교환 시작), F-145 AI Match List(이유 전체 · 필터),
// F-146 현장 미팅 요청(추천마다), F-142 참가자 등록(주최자), F-150 배지 스캐너
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { BadgeLeadScanner } from "@/components/BadgeLeadScanner";
import { EventMeetings } from "@/components/EventMeetings";
import { AiLabel, Avatar, Empty, PageHeader } from "@/components/Page";
import { SlotPicker } from "@/components/Scheduling";
import { ClientError, api } from "@/lib/client";
import { AttendeeRegistration } from "./AttendeeRegistration";

type Reason = { kind: "need_offer" | "offer_need" | "industry" | "region" | "trust" | "project"; text: string; weight: number };
type Match = { candidateId: string; candidateName: string; company: string | null; slug: string; score: number; reasons: Reason[] };

/** reason kinds → filter chips (Need↔Offer counts both directions) */
const FILTERS = [
  ["all", "전체", null],
  ["fit", "Need ↔ Offer", ["need_offer", "offer_need"]],
  ["industry", "같은 산업", ["industry"]],
  ["region", "같은 지역", ["region"]],
  ["project", "프로젝트", ["project"]],
  ["trust", "기존 관계", ["trust"]],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

function MeetingRequest({ eventId, match, onSent, onCancel }: { eventId: string; match: Match; onSent: () => void; onCancel: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (slots: { startsAt: string; endsAt: string }[]) => {
    if (!slots.length) return setError("후보 시간을 하나 이상 고르세요.");
    setBusy(true);
    setError(null);
    try {
      await api(`/events/${eventId}/meeting-requests`, { body: { targetProfileId: match.candidateId, slots, message: message || undefined } });
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-[var(--line)] pt-3" data-testid="match-meeting-form">
      <p className="text-[13.5px] text-[var(--fg-mute)]">{match.candidateName}님께 현장 1:1 미팅을 요청해요. 상대 이메일은 공유되지 않고, 상대가 시간을 고르면 확정됩니다.</p>
      <input className="field" placeholder="한 줄 메시지 (선택)" maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} aria-label={`${match.candidateName}님께 보낼 메시지`} />
      <SlotPicker cta="요청 보내기" onSubmit={send} busy={busy} />
      <button type="button" className="text-[13px] text-[var(--fg-mute)] underline-offset-4 hover:underline" onClick={onCancel}>취소</button>
      {error && <p role="alert" className="text-[13.5px] text-[var(--color-ember)]">{error}</p>}
    </div>
  );
}

export function EventDetail({ id }: { id: string }) {
  const [e, setE] = useState<any>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [m, setM] = useState<{ results: Match[] } | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [requesting, setRequesting] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [meetKey, setMeetKey] = useState(0);
  const reload = () =>
    api(`/events/${id}`)
      .then((x) => {
        setE(x);
        setLoadError(null);
      })
      .catch((err) => setLoadError({ status: err instanceof ClientError ? err.status : 0, message: (err as Error).message }));
  const loadMatches = () => {
    setMatchError(null);
    api<{ results: Match[] }>(`/events/${id}/matches`).then(setM).catch((err) => setMatchError((err as Error).message));
  };
  useEffect(() => {
    reload();
    loadMatches();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const kinds = useMemo(() => new Set((m?.results ?? []).flatMap((r) => r.reasons.map((x) => x.kind))), [m]);
  const visible = useMemo(() => {
    const f = FILTERS.find(([k]) => k === filter)?.[2];
    return (m?.results ?? []).filter((r) => !f || r.reasons.some((x) => (f as readonly string[]).includes(x.kind)));
  }, [m, filter]);

  // F-150: the badge scanner works even when the event could not be loaded (offline at the venue)
  if (!e) {
    return (
      <div className="space-y-4">
        {loadError && loadError.status !== 0 ? (
          <Empty
            title={loadError.status === 404 ? "행사를 찾을 수 없어요" : "행사를 불러오지 못했어요"}
            body={loadError.status === 404 ? "참가하지 않았거나 삭제된 행사예요. 참가 코드로 입장해 주세요." : loadError.message}
            action={<span className="flex gap-2"><button className="btn btn-ghost" onClick={reload}>다시 시도</button><Link href="/app/events" className="btn btn-ink">내 행사</Link></span>}
          />
        ) : (
          <div className="surface h-40 animate-pulse" />
        )}
        {loadError?.status !== 404 && <BadgeLeadScanner eventId={id} onSaved={reload} />}
      </div>
    );
  }
  return (
    <div>
      <PageHeader back="/app/events" eyebrow={e.venue ?? "Event"} title={e.name} />
      <div className={`grid gap-3 ${e.isOwner ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
        {[["참가자", e.attendees], ["추천 공개", e.optedIn], ["내 리드", e.leads.length], ...(e.isOwner ? [["사전 등록", e.registered ?? 0]] : [])].map(([l, v]) => (
          <div key={l} className="surface p-4"><p className="text-[12px] text-[var(--fg-mute)]">{l}</p><p className="display num text-[36px]">{v}</p></div>
        ))}
      </div>
      {e.isOwner && <p className="mt-4 text-[14px]">참가 코드 <b className="num tracking-[0.2em]">{e.joinCode}</b> — 참가자에게 공유하세요.</p>}
      {/* F-143: start an exchange tagged with this event — every card received lands here as an event lead */}
      <Link href={`/app/exchange?event=${id}`} className="btn btn-signal btn-lg mt-4 w-full" data-testid="event-exchange-start">
        <Icon name="exchange" size={20} /> 이 행사로 교환 시작
      </Link>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/app/events/${id}/booth`} className="btn btn-ghost"><Icon name="flag" size={18} /> 부스 모드 · 리드 · ROI</Link>
        {/* X-007 printable poster / table tent for this event */}
        <Link href={`/app/me/share?event=${id}#poster`} className="btn btn-ghost" data-testid="event-poster-link"><Icon name="download" size={18} /> 포스터 · 테이블 텐트</Link>
      </div>

      <section className="mt-8" aria-labelledby="recs-h">
        <h2 id="recs-h" className="mb-1 text-[18px] font-semibold">오늘 만나볼 사람</h2>
        <p className="mb-3 flex items-center gap-2 text-[13px] text-[var(--fg-mute)]"><AiLabel /> 추천 노출에 동의한 참가자만 · 공유한 Offer/Need 기반</p>
        {matchError ? (
          <div role="alert" className="surface flex flex-wrap items-center gap-3 p-4 text-[14px]">
            <span className="min-w-0 flex-1 text-[var(--color-ember)]">추천을 불러오지 못했어요 — {matchError}</span>
            <button className="btn btn-ghost !min-h-10" onClick={loadMatches}>다시 시도</button>
          </div>
        ) : !m ? (
          <div className="surface h-24 animate-pulse" />
        ) : m.results.length === 0 ? (
          <Empty title="아직 추천이 없어요" body="Offer/Need를 채운 참가자가 늘어나면 추천이 생겨요." />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="추천 이유로 거르기">
              {FILTERS.filter(([k, , ks]) => k === "all" || ks!.some((x) => kinds.has(x))).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`chip ${filter === k ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
                  {label}
                </button>
              ))}
            </div>
            {visible.length === 0 ? (
              <Empty title="이 조건의 추천이 없어요" action={<button className="btn btn-ghost" onClick={() => setFilter("all")}>전체 보기</button>} />
            ) : (
              <ul className="space-y-2" data-testid="event-recs">
                {visible.map((r) => (
                  <li key={r.candidateId} className="surface p-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={r.candidateName} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{r.candidateName} <span className="font-normal text-[var(--fg-mute)]">{r.company ?? ""}</span></span>
                      </span>
                      <span className="text-right">
                        <span className="display num block text-[28px] leading-none">{Math.round(r.score * 100)}</span>
                        <span className="text-[11px] text-[var(--fg-mute)]">추천 점수</span>
                      </span>
                    </div>
                    <ul className="mt-3 space-y-1" aria-label={`${r.candidateName} 추천 이유`}>
                      {r.reasons.map((x, i) => (
                        <li key={i} className="flex gap-2 text-[13.5px]">
                          <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--accent-text)]" />
                          <span>{x.text}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {sentTo.has(r.candidateId) ? (
                        <span className="chip" role="status">요청 보냄 · 응답 대기</span>
                      ) : (
                        <button type="button" className="btn btn-signal !min-h-10 text-[14px]" aria-expanded={requesting === r.candidateId} onClick={() => setRequesting(requesting === r.candidateId ? null : r.candidateId)} data-testid="match-meeting-request">
                          <Icon name="calendar" size={16} /> 현장 미팅 요청
                        </button>
                      )}
                      {r.slug && <Link href={`/p/${r.slug}`} className="btn btn-ghost !min-h-10 text-[14px]" aria-label={`${r.candidateName} 카드 보기`}>카드 보기</Link>}
                    </div>
                    {requesting === r.candidateId && (
                      <MeetingRequest
                        eventId={id}
                        match={r}
                        onCancel={() => setRequesting(null)}
                        onSent={() => {
                          setRequesting(null);
                          setSentTo((cur) => new Set(cur).add(r.candidateId));
                          setMeetKey((k) => k + 1);
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <EventMeetings key={meetKey} eventId={id} />

      {e.isOwner && <AttendeeRegistration eventId={id} onChanged={reload} />}

      <section className="mt-8">
        <BadgeLeadScanner eventId={id} onSaved={reload} />
      </section>
      <section className="mt-8">
        <h2 className="mb-3 text-[18px] font-semibold">이 행사에서 받은 명함</h2>
        {e.leads.length === 0 ? <Empty title="아직 없어요" body="‘이 행사로 교환 시작’으로 교환하면 받은 명함이 여기 리드로 모입니다." /> : (
          <ul className="surface divide-y divide-[var(--line)]">
            {e.leads.map((l: any) => <li key={l.contactId}><Link href={`/app/people/${l.contactId}`} className="flex items-center gap-3 px-4 py-3"><Avatar name={l.fullName} size={36} />{l.fullName}<span className="text-[13px] text-[var(--fg-mute)]">{l.company}</span></Link></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
