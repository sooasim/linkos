"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel } from "@/components/Page";
import { api } from "@/lib/client";

// F-098 미접촉 위험 · F-099 Opportunity Detection — explainable, labeled "AI 추론", nothing is acted on automatically
export function NetworkInsights() {
  const [cool, setCool] = useState<any[] | null>(null);
  const [opps, setOpps] = useState<any[] | null>(null);
  useEffect(() => {
    api<{ results: any[] }>("/relationships/cooling").then((r) => setCool(r.results)).catch(() => setCool([]));
    api<{ results: any[] }>("/ai/opportunities").then((r) => setOpps(r.results)).catch(() => setOpps([]));
  }, []);
  return (
    <div className="mt-8 space-y-6">
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 px-1 font-semibold"><Icon name="flag" size={18} />식어가는 관계 <AiLabel /></h2>
        {cool === null ? <div className="surface h-20 animate-pulse" /> : cool.length === 0 ? (
          <p className="surface p-4 text-[14px] text-[var(--fg-mute)]">방치된 중요한 관계가 없어요.</p>
        ) : (
          <ul className="surface divide-y divide-[var(--line)]">
            {cool.slice(0, 8).map((c) => (
              <li key={c.contactId}>
                <Link href={`/app/people/${c.contactId}`} className="flex items-center gap-3 px-4 py-3">
                  <span className={`chip ${c.level === "high" ? "!border-[var(--color-ember)] !text-[var(--color-ember)]" : ""}`}>{c.level === "high" ? "위험" : "주의"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{c.fullName}{c.company ? ` · ${c.company}` : ""}</span>
                    <span className="block truncate text-[12.5px] text-[var(--fg-mute)]">{c.reasons.join(" · ")}</span>
                  </span>
                  <span className="num text-[13px] text-[var(--fg-mute)]">{c.daysSilent}일</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 px-1 font-semibold"><Icon name="bolt" size={18} />사업 기회 <AiLabel /></h2>
        {opps === null ? <div className="surface h-20 animate-pulse" /> : opps.length === 0 ? (
          <p className="surface p-4 text-[14px] text-[var(--fg-mute)]">메모·미팅·카드의 Need와 네트워크의 Offer가 맞는 경우가 아직 없어요.</p>
        ) : (
          <ul className="space-y-2">
            {opps.slice(0, 8).map((o, i) => (
              <li key={i} className="surface p-4 text-[14px]">
                <p className="font-semibold">{o.need.personName} ↔ {o.offer.personName} <span className="chip ml-1">{Math.round(o.score * 100)}</span></p>
                <ul className="mt-1 list-disc pl-5 text-[13px] text-[var(--fg-mute)]">
                  {o.reasons.map((r: string, j: number) => <li key={j}>{r}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
