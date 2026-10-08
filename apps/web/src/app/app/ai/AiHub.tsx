"use client";
// UX-017 관계 기억 검색 · UX-018 Need↔Offer 매칭 — 실패는 조용히 숨기지 않고 오류 + 다시 시도로 보여준다.
// 매칭마다 "소개하기"(내 연락처인 경우 /app/intros?a=…)로 바로 이어진다. 매칭은 AI 추론 라벨과 함께 표시.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Avatar, Empty } from "@/components/Page";
import { ClientError, api, fmtDate } from "@/lib/client";

const EXAMPLES = ["작년 코엑스에서 만난 의료 AI 대표", "투자 관심 있다고 메모한 사람", "지난달 만난 파트너"];
const errText = (e: unknown) => (e instanceof ClientError && e.status === 429 ? "요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 시도하세요." : (e as Error).message || "요청을 처리하지 못했습니다.");

function ErrorBox({ title, message, onRetry, busy }: { title: string; message: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="surface flex flex-wrap items-center gap-3 p-4" data-testid="ai-error">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[var(--color-ember)]">{title}</span>
        <span className="block text-[13.5px] text-[var(--fg-mute)]">{message}</span>
      </span>
      <button type="button" className="btn btn-ghost !min-h-10" onClick={onRetry} disabled={busy} data-testid="ai-retry">다시 시도</button>
    </div>
  );
}

const EV_LABEL: Record<string, string> = { contact: "연락처", encounter: "만남", note: "메모", meeting: "미팅", event: "행사" };

export function AiHub() {
  const [tab, setTab] = useState<"search" | "match">("search");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<any>(null);
  const [searchError, setSearchError] = useState<{ query: string; message: string } | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);

  const loadMatches = async () => {
    setMatchError(null);
    setMatchBusy(true);
    try {
      setMatches(await api("/matches"));
    } catch (e) {
      setMatchError(errText(e));
    } finally {
      setMatchBusy(false);
    }
  };
  useEffect(() => {
    if (tab === "match" && !matches && !matchError && !matchBusy) void loadMatches();
  }, [tab, matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (query = q) => {
    if (!query.trim()) return;
    setQ(query);
    setBusy(true);
    setSearchError(null);
    try {
      // read-only query: never queued in the offline outbox
      setRes(await api("/ai/search", { body: { query }, offline: false }));
    } catch (e) {
      setRes(null);
      setSearchError({ query, message: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div role="tablist" className="surface flex p-1">
        {(
          [
            ["search", "관계 기억 검색"],
            ["match", "Need ↔ Offer 매칭"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex-1 rounded-[16px] py-2.5 text-[14px] font-semibold ${tab === k ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--fg-mute)]"}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === "search" && (
        <section className="space-y-4">
          <form onSubmit={(e) => { e.preventDefault(); search(); }} className="relative">
            <Icon name="spark" size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fg-mute)]" />
            <input className="field !min-h-14 !pl-12 !pr-24 !text-[17px]" placeholder="누구를 찾고 있나요?" value={q} onChange={(e) => setQ(e.target.value)} aria-label="자연어 관계 검색" />
            <button className="btn btn-signal absolute right-1.5 top-1/2 !min-h-11 -translate-y-1/2" disabled={busy}>{busy ? "…" : "찾기"}</button>
          </form>
          {searchError && <ErrorBox title="검색하지 못했어요" message={searchError.message} onRetry={() => search(searchError.query)} busy={busy} />}
          {!res && !searchError && (
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button key={e} onClick={() => search(e)} className="chip hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]">{e}</button>
              ))}
            </div>
          )}
          {res && (
            <div className="space-y-3">
              <p className="text-[13px] text-[var(--fg-mute)]">
                해석: {res.interpreted.terms.join(", ") || "—"} {res.interpreted.from && `· ${fmtDate(res.interpreted.from, { year: "numeric", month: "short" })} ~ ${fmtDate(res.interpreted.to, { year: "numeric", month: "short" })}`} · 내 기록에서만 검색
              </p>
              {res.results.length === 0 ? (
                <Empty title="일치하는 사람을 찾지 못했어요" body="만난 장소나 메모를 남겨두면 다음에 더 잘 찾아드려요." />
              ) : (
                res.results.map((r: any) => (
                  <Link key={r.contactId} href={`/app/people/${r.contactId}`} className="surface block p-4 transition hover:border-[var(--line-strong)]">
                    <div className="flex items-center gap-3">
                      <Avatar name={r.fullName} size={40} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{r.fullName}</p>
                        <p className="text-[13px] text-[var(--fg-mute)]">{[r.company, r.jobTitle].filter(Boolean).join(" · ")}</p>
                      </div>
                    </div>
                    <ul className="mt-3 space-y-1.5 border-t border-[var(--line)] pt-3">
                      {r.evidence.map((e: any, i: number) => (
                        <li key={i} className="flex gap-2 text-[13.5px]">
                          <span className="chip !py-0 text-[11px]">{EV_LABEL[e.kind] ?? e.kind}</span>
                          <span className="min-w-0 flex-1 truncate text-[var(--fg-mute)]">{e.text}</span>
                          {e.at && <span className="text-[12px] text-[var(--fg-mute)]">{fmtDate(e.at)}</span>}
                        </li>
                      ))}
                    </ul>
                  </Link>
                ))
              )}
            </div>
          )}
        </section>
      )}

      {tab === "match" && (
        <section className="space-y-3">
          <p className="flex items-center gap-2 text-[13.5px] text-[var(--fg-mute)]">
            <AiLabel /> 내 Need/Offer와 상대가 공개한 정보로만 계산합니다. 소개·연락은 항상 직접 결정하세요.
          </p>
          {matchError ? (
            <ErrorBox title="매칭을 불러오지 못했어요" message={matchError} onRetry={loadMatches} busy={matchBusy} />
          ) : !matches ? (
            <div className="surface h-32 animate-pulse" />
          ) : matches.subject === null ? (
            <Empty title="먼저 Living Card에 Offer/Need를 적어주세요" action={<Link href="/app/me/edit" className="btn btn-signal">카드 편집</Link>} />
          ) : matches.results.length === 0 ? (
            <Empty title="아직 추천할 연결이 없어요" body="LINKOS를 쓰는 사람과 교환하거나 행사에 참여하면 매칭 후보가 생겨요." />
          ) : (
            matches.results.map((m: any) => (
              <article key={m.candidateId} className="surface p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={m.candidateName} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{m.candidateName}</p>
                    <p className="text-[13px] text-[var(--fg-mute)]">{m.company ?? ""}</p>
                  </div>
                  <div className="text-right">
                    <p className="display num text-[34px] leading-none">{Math.round(m.score * 100)}</p>
                    <p className="text-[11px] text-[var(--fg-mute)]">매칭 점수</p>
                  </div>
                </div>
                <ul className="mt-3 space-y-1.5">
                  {m.reasons.map((r: any, i: number) => (
                    <li key={i} className="flex gap-2 text-[14px]">
                      <Icon name="check" size={16} className="mt-0.5 shrink-0 text-[var(--color-signal-deep)]" />
                      {r.text}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  {m.slug && <Link href={`/p/${m.slug}`} className="btn btn-ghost !min-h-10 text-[14px]">카드 보기</Link>}
                  {m.contactId && <Link href={`/app/meetings/new?contact=${m.contactId}`} className="btn btn-ghost !min-h-10 text-[14px]">미팅 제안</Link>}
                  {/* consent-based introduction starts from MY contact record (party A preselected) */}
                  {m.contactId ? (
                    <Link href={`/app/intros?a=${m.contactId}`} className="btn btn-signal !min-h-10 text-[14px]" data-testid="match-intro" aria-label={`${m.candidateName}님 소개하기`}>
                      <Icon name="link" size={16} /> 소개하기
                    </Link>
                  ) : (
                    <span className="self-center text-[12.5px] text-[var(--fg-mute)]">행사에서 추천된 사람이에요 — 명함을 교환하면 소개할 수 있어요</span>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
