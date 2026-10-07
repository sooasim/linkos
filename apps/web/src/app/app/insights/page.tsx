import { analytics, growth } from "@linkos/api";
import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { CHANNEL_LABEL_KO, type Channel } from "@linkos/domain";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "인사이트" };

function Stat({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <div className="surface p-5">
      <p className="text-[13px] font-medium text-[var(--fg-mute)]">{label}</p>
      <p className="display num mt-2 text-[48px] leading-none">{value === null ? "—" : `${value}%`}</p>
      <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">{hint}</p>
    </div>
  );
}

// 백서 23 핵심 KPI (개인 범위)
export default async function InsightsPage() {
  const { userId } = await getViewer();
  const k = await analytics.exchangeKpis(userId!, 30);
  const v = await growth.viralReport(30, userId!); // F-189 my part of the viral loop
  const max = Math.max(1, ...k.channels.map((c: any) => c.attempts));
  return (
    <div>
      <PageHeader eyebrow="최근 30일" title={<>나의 <em>교환 지표</em></>} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Exchange Success" value={k.exchangeSuccessRate} hint={`공유 ${k.funnel.created} → 열람 ${k.funnel.opened}`} />
        <Stat label="Reciprocal" value={k.reciprocalRate} hint={`열람 → 회신 ${k.funnel.reciprocated}`} />
        <Stat label="Claim" value={k.claimRate} hint={`회신 → 계정 Claim ${k.funnel.claimed}`} />
        <Stat label="Follow-up 완료" value={k.followupCompletion} hint="추천 후속 행동 수행률" />
      </div>
      <section className="surface mt-6 p-5">
        <h2 className="text-[17px] font-semibold">채널별 시도</h2>
        <ul className="mt-4 space-y-3">
          {k.channels.length === 0 && <li className="text-[14px] text-[var(--fg-mute)]">아직 기록이 없어요.</li>}
          {k.channels.map((c: any) => (
            <li key={c.channel}>
              <div className="flex justify-between text-[14px]"><span>{CHANNEL_LABEL_KO[c.channel as Channel] ?? c.channel}</span><span className="num text-[var(--fg-mute)]">{c.success}/{c.attempts}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]">
                <div className="h-full rounded-full bg-[var(--fg)]" style={{ width: `${(c.attempts / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-4 text-[14px]">내 교환으로 LINKOS를 시작한 사람 <b className="num">{v.claims}</b>명{v.claimedWhoShared ? ` · 그중 ${v.claimedWhoShared}명이 다시 명함을 공유` : ""}</p>
      <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">OCR 수정률: {k.ocrCorrectionRate ?? "—"}% (스캔·교환으로 들어온 연락처 중 직접 수정한 비율)</p>
    </div>
  );
}
