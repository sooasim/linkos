import { assistantJobs } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { AiLabel, Empty, PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { DraftButton } from "./DraftButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "다시 연락하기" };

// X-006 weekly re-connect digest — 3 cooling relationships, one-tap DRAFT (never auto-sent; CLAUDE.md rule 8)
export default async function ReconnectPage() {
  const { ctx } = await getViewer();
  const d = await assistantJobs.currentDigest(ctx);
  return (
    <div>
      <PageHeader back="/app/insights" eyebrow={`${d.weekStart} 주`} title={<>다시 <em>연락</em>해 볼 사람</>} />
      <p className="mb-4 flex flex-wrap items-center gap-2 text-[13.5px] text-[var(--fg-mute)]">
        <AiLabel /> 만남 간격·관계 강도로 추정했어요. 초안은 저장만 되고, 보내기는 직접 확인한 뒤에만 가능해요.
        {!d.enabled && <Link href="/app/settings#assistant" className="underline">주간 알림이 꺼져 있어요</Link>}
      </p>
      {d.items.length === 0 ? (
        <Empty title="이번 주는 챙길 사람이 없어요" body="관계가 멀어지기 시작하면 여기에서 알려드려요." action={<Link href="/app/people" className="btn btn-ghost">인맥 보기</Link>} />
      ) : (
        <ul className="stagger space-y-3" data-testid="reconnect-list">
          {d.items.map((i) => (
            <li key={i.contactId} className="surface p-4">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/app/people/${i.contactId}`} className="min-w-0">
                  <span className="block truncate text-[16px] font-semibold">{i.fullName}</span>
                  <span className="block text-[13px] text-[var(--fg-mute)]">{[i.company, `${i.daysSilent}일째 연락 없음`, i.lastPlace ? `마지막: ${i.lastPlace}` : null].filter(Boolean).join(" · ")}</span>
                </Link>
                <span className={`chip shrink-0 ${i.level === "high" ? "!bg-[var(--color-peach)]" : "!bg-[var(--color-butter)]"} !text-[var(--color-ink)]`}>{i.level === "high" ? "높음" : "보통"}</span>
              </div>
              {i.reasons?.length ? <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">근거: {i.reasons.join(" · ")}</p> : null}
              <DraftButton contactId={i.contactId} existingMessageId={i.draftMessageId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
