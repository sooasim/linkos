"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel, Avatar, Empty } from "@/components/Page";
import { api, fmtDate } from "@/lib/client";

const EXAMPLES = ["작년 코엑스에서 만난 의료 AI 대표", "투자 관심 있다고 메모한 사람", "지난달 만난 파트너"];
const EV_LABEL: Record<string, string> = { contact: "연락처", encounter: "만남", note: "메모", meeting: "미팅", event: "행사" };

export function AiHub() {
  const [tab, setTab] = useState<"search" | "match">("search");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<any>(null);

  useEffect(() => {
    if (tab === "match" && !matches) api("/matches").then(setMatches).catch(() => setMatches({ results: [] }));
  }, [tab, matches]);

  const search = async (query = q) => {
    if (!query.trim()) return;
    setQ(query);
    setBusy(true);
    try {
      setRes(await api("/ai/search", { body: { query } }));
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
          {!res && (
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
          {!matches ? (
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
                <div className="mt-4 flex gap-2">
                  {m.slug && <Link href={`/p/${m.slug}`} className="btn btn-ghost !min-h-10 text-[14px]">카드 보기</Link>}
                  {m.contactId && <Link href={`/app/meetings/new?contact=${m.contactId}`} className="btn btn-signal !min-h-10 text-[14px]">미팅 제안</Link>}
                </div>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
