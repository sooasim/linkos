import { meeting } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Empty, PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "미팅" };

export default async function MeetingsPage() {
  const { userId } = await getViewer();
  const list = await meeting.listMeetings(userId!);
  return (
    <div>
      <PageHeader eyebrow="Meeting Intelligence" title={<>미팅 <em>카드</em></>} action={<Link href="/app/meetings/new" className="btn btn-signal !min-h-11"><Icon name="plus" size={17} />새 미팅</Link>} />
      {list.length === 0 ? (
        <Empty title="미팅 카드가 없어요" body="목적·결정·약속·To-do·다음 일정을 한 장에 정리하세요." />
      ) : (
        <ul className="space-y-2">
          {list.map((m: any) => (
            <li key={m.id}>
              <Link href={`/app/meetings/${m.id}`} className="surface flex items-center gap-4 p-4 transition hover:border-[var(--line-strong)]">
                <span className="display num w-14 text-center text-[30px] leading-none">{new Date(m.started_at ?? m.created_at).getDate()}<span className="block text-[11px] font-sans text-[var(--fg-mute)]">{new Intl.DateTimeFormat("ko-KR", { month: "short" }).format(new Date(m.started_at ?? m.created_at))}</span></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{m.title}</span>
                  <span className="block text-[13px] text-[var(--fg-mute)]">열린 To-do {m.open_actions}</span>
                </span>
                <Icon name="arrow" size={16} className="opacity-40" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
