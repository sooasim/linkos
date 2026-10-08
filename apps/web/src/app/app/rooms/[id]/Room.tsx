"use client";
// UX-020 Connection Room — 참여자(소개자 · 양측, 역할/직함/동의 상태), 소개 이유, Next Action, 기록, 요약(F-158).
// 로딩 실패·없는 방은 끝없는 스켈레톤 대신 오류/찾을 수 없음 상태를 보여준다.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, AiLabel, Empty, PageHeader } from "@/components/Page";
import { RoomFiles } from "@/components/RoomFiles";
import { RoomMeeting } from "@/components/RoomMeeting";
import { ClientError, api, relTime } from "@/lib/client";

const ROLE: Record<string, string> = { introducer: "소개자 (나)", party_a: "소개받는 분 A", party_b: "소개받는 분 B" };
const STATUS: Record<string, string> = { accepted: "동의함", declined: "거절함", pending: "응답 대기" };

function Participants({ list }: { list: { role: string; name: string | null; company: string | null; jobTitle: string | null; contactId: string | null; status: string }[] }) {
  if (!list?.length) return null;
  return (
    <section className="surface mt-4 p-4" aria-labelledby="room-people-h">
      <h2 id="room-people-h" className="eyebrow">참여자 {list.length}</h2>
      <ul className="mt-2 divide-y divide-[var(--line)]" data-testid="room-participants">
        {list.map((p) => {
          const body = (
            <>
              <Avatar name={p.name ?? "?"} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.name ?? "이름 없음"}</span>
                <span className="block truncate text-[13px] text-[var(--fg-mute)]">{[p.jobTitle, p.company].filter(Boolean).join(" · ") || ROLE[p.role]}</span>
              </span>
              <span className="chip !text-[12px]">{ROLE[p.role] ?? p.role}</span>
              {p.role !== "introducer" && <span className="text-[12px] text-[var(--fg-mute)]">{STATUS[p.status] ?? p.status}</span>}
            </>
          );
          return (
            <li key={p.role}>
              {p.contactId ? (
                <Link href={`/app/people/${p.contactId}`} className="flex items-center gap-3 py-2.5">{body}</Link>
              ) : (
                <div className="flex items-center gap-3 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = () =>
    api(`/rooms/${id}`)
      .then((x) => {
        setR(x);
        setNext(x.nextAction ?? "");
        setError(null);
      })
      .catch((e) => setError({ status: e instanceof ClientError ? e.status : 0, message: (e as Error).message }));
  const act = (p: Promise<unknown>) => p.then(() => setActionError(null)).then(load).catch((e) => setActionError((e as Error).message));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r && error) {
    return (
      <div data-testid="room-error">
        <PageHeader back="/app/intros" eyebrow="Connection Room" title={error.status === 404 ? "방을 찾을 수 없어요" : "방을 열지 못했어요"} />
        <Empty
          title={error.status === 404 ? "삭제되었거나 접근 권한이 없는 Connection Room이에요" : "잠시 후 다시 시도하세요"}
          body={error.status === 404 ? "소개 화면에서 양측 동의가 끝난 소개의 방을 열 수 있어요." : error.message}
          action={
            <span className="flex gap-2">
              {error.status !== 404 && <button className="btn btn-ghost" onClick={load}>다시 시도</button>}
              <Link href="/app/intros" className="btn btn-ink">소개 목록</Link>
            </span>
          }
        />
      </div>
    );
  }
  if (!r) return <div className="surface h-40 animate-pulse" aria-busy="true" aria-label="불러오는 중" />;
  return (
    <div>
      <PageHeader back="/app/intros" eyebrow={r.status === "won" ? "성사" : "Connection Room"} title={r.introduction ? <>{r.introduction.partyA.name} <em>&</em> {r.introduction.partyB.name}</> : r.title} />
      <section className="surface p-4">
        <p className="eyebrow">소개 이유</p>
        <p className="mt-1">{r.purpose}</p>
      </section>
      <Participants list={r.participants ?? []} />
      <section className="mt-4 flex gap-2">
        <input className="field" placeholder="Next Action" aria-label="Next Action" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="btn btn-ink shrink-0" onClick={() => act(api(`/rooms/${id}`, { method: "PATCH", body: { nextAction: next } }))}>저장</button>
        <button className="btn btn-signal shrink-0" onClick={() => act(api(`/rooms/${id}`, { method: "PATCH", body: { status: "won" } }))}>성사</button>
      </section>
      {actionError && <p role="alert" className="mt-2 text-[13.5px] text-[var(--color-ember)]">{actionError}</p>}
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
      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!msg.trim()) return; void act(api(`/rooms/${id}/messages`, { body: { body: msg } }).then(() => setMsg(""))); }}>
        <input className="field" placeholder="자료, 메모, 진행 상황" aria-label="Room 기록" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="btn btn-signal shrink-0">기록</button>
      </form>
      <RoomMeeting roomId={id} />
    </div>
  );
}
