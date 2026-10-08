import { ApiError, assistantJobs } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AiLabel, Empty, PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "30초 브리핑" };

const KIND_LABEL: Record<string, string> = { who: "누구", last_met: "마지막 만남", note: "내 메모", open_action: "할 일", their_offer: "상대 Offer", their_need: "상대 Need", topic: "대화 주제" };

// X-005 "만나기 전 30초 브리핑" — 내 기록만 다시 보여주고, 추론한 주제는 'AI 추론' 라벨
export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await getViewer();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let r: Awaited<ReturnType<typeof assistantJobs.getPrepBrief>>;
  try {
    r = await assistantJobs.getPrepBrief(ctx, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div>
      <PageHeader back="/app/brief" eyebrow={new Date(r.startsAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} title={<>{r.title} <em>브리핑</em></>} />
      {r.location && <p className="mb-4 text-[14px] text-[var(--fg-mute)]">장소: {r.location}</p>}
      {!r.brief ? (
        <Empty title="이 일정에는 아는 참석자가 없어요" body="연락처에 있는 사람이 참석하는 일정만 브리핑을 만들어요." />
      ) : (
        <>
          <ul className="stagger space-y-2" data-testid="brief-items">
            {r.brief.items.map((it, i) => (
              <li key={i} className={`surface p-4 ${it.provenance === "ai_inferred" ? "glow-border" : ""}`}>
                <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-mute)]">
                  {KIND_LABEL[it.kind] ?? it.kind} {it.provenance === "ai_inferred" && <AiLabel />}
                </p>
                <p className="mt-1 text-[15px]">{it.text}</p>
              </li>
            ))}
          </ul>
          {r.brief.empty && <p className="mt-3 text-[14px] text-[var(--fg-mute)]">이전 만남·메모 기록이 없어요. 모르는 사실은 만들어 내지 않아요.</p>}
          <p className="mt-4 text-[12.5px] text-[var(--fg-mute)]">출처: 내 연락처·만남·메모·할 일 기록{r.brief.aiInferredCount ? ` · AI 추론 ${r.brief.aiInferredCount}건은 확인 후 활용하세요` : ""}.</p>
          <Link href={`/app/people/${r.brief.contactId}`} className="btn btn-ghost mt-4">상대 기록 열기</Link>
        </>
      )}
    </div>
  );
}
