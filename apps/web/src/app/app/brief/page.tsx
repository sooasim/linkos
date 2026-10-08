import { assistantJobs } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Empty, PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "미팅 전 브리핑" };

// X-005 다가오는 확정 일정 → 30초 브리핑
export default async function BriefIndex() {
  const { ctx } = await getViewer();
  const { prefs, upcoming } = await assistantJobs.upcomingBriefs(ctx);
  return (
    <div>
      <PageHeader back="/app/insights" eyebrow="Before you meet" title={<>만나기 전 <em>30초</em></>} />
      <p className="mb-4 text-[14px] text-[var(--fg-mute)]">
        {prefs.prepBriefLeadMin > 0 ? `확정된 일정 ${prefs.prepBriefLeadMin}분 전에 알림으로 보내요.` : "브리핑 알림이 꺼져 있어요."} <Link href="/app/settings#assistant" className="underline">설정</Link>
      </p>
      {upcoming.length === 0 ? (
        <Empty title="7일 안에 확정된 일정이 없어요" body="일정을 확정하면 상대와의 기록을 모아 미팅 전에 알려드려요." action={<Link href="/app/calendar" className="btn btn-ghost">일정 보기</Link>} />
      ) : (
        <ul className="space-y-2" data-testid="brief-list">
          {upcoming.map((u) => (
            <li key={u.candidateId}>
              <Link href={`/app/brief/${u.candidateId}`} className="surface flex items-center gap-4 p-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--color-sky)] text-[var(--color-ink)]"><Icon name="calendar" size={20} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{u.title}</span>
                  <span className="block text-[13px] text-[var(--fg-mute)]">{new Date(u.startsAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} · {u.contactName ?? "아는 참석자 없음"}</span>
                </span>
                <Icon name="arrow" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
