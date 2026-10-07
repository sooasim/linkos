import { card, event } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { BackgroundTool, PosterTool, SignatureTool, WalletTool } from "./ShareTools";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "공유 도구" };

// X-001 / X-002 / X-004 / X-007 — 내 Living Card를 메일·화상회의·지갑·행사 테이블로
export default async function ShareToolsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { userId, ctx } = await getViewer();
  if (!(await card.primaryProfileId(userId!))) redirect("/app/me/edit?onboarding=1");
  const { event: eventId } = await searchParams;
  let eventName: string | null = null;
  if (eventId && /^[0-9a-f-]{36}$/i.test(eventId)) eventName = ((await event.getEvent(ctx, eventId).catch(() => null)) as { name?: string } | null)?.name ?? null;
  return (
    <div>
      <PageHeader back="/app/me" eyebrow="Share kit" title={<>카드를 <em>어디서나</em></>} />
      <div className="stagger space-y-4">
        <section id="signature" className="surface p-5" aria-labelledby="sig-h" data-reveal>
          <h2 id="sig-h" className="text-[18px] font-semibold">메일 서명</h2>
          <p className="mb-4 mt-1 text-[13.5px] text-[var(--fg-mute)]">세 가지 스타일 중 고르고 복사해 Gmail·Outlook 서명에 붙여넣으세요.</p>
          <SignatureTool />
        </section>
        <section id="background" className="surface p-5" aria-labelledby="bg-h" data-reveal>
          <h2 id="bg-h" className="text-[18px] font-semibold">화상회의 가상 배경</h2>
          <p className="mb-4 mt-1 text-[13.5px] text-[var(--fg-mute)]">이름·직함·회사·짧은 링크가 들어간 1920×1080 배경.</p>
          <BackgroundTool />
        </section>
        <section id="wallet" className="surface p-5" aria-labelledby="wallet-h" data-reveal>
          <h2 id="wallet-h" className="text-[18px] font-semibold">지갑에 넣기</h2>
          <p className="mb-4 mt-1 text-[13.5px] text-[var(--fg-mute)]">휴대폰 지갑에서 바로 내 카드 링크를 꺼내 보여주세요.</p>
          <WalletTool />
        </section>
        <section id="poster" className="surface p-5" aria-labelledby="poster-h" data-reveal>
          <h2 id="poster-h" className="text-[18px] font-semibold">행사용 포스터 · 테이블 텐트</h2>
          <p className="mb-4 mt-1 text-[13.5px] text-[var(--fg-mute)]">부스나 테이블에 세워 두면 지나가는 사람이 단축코드로 바로 명함을 교환해요.{eventName ? ` (${eventName})` : ""}</p>
          <PosterTool eventId={eventName ? eventId : null} eventName={eventName} />
        </section>
      </div>
      <p className="mt-6 text-[13px] text-[var(--fg-mute)]">
        이 도구로 공유된 링크의 조회 수는 <Link href="/app/insights" className="underline">인사이트</Link>에서 볼 수 있어요.
      </p>
    </div>
  );
}
