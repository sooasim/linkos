import { card } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { CardFace } from "@/components/LivingCard";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { ExchangeConsole } from "./ExchangeConsole";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "교환" };

// UX-002 Exchange Start + UX-004 Share Handoff
export default async function ExchangePage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const { userId } = await getViewer();
  const sp = await searchParams;
  const pid = await card.primaryProfileId(userId!);
  const profile = pid ? await card.loadProfile(pid) : null;
  if (!profile) {
    return (
      <div>
        <PageHeader eyebrow="Exchange" title={<>교환하려면 <em>카드</em>가 필요해요</>} />
        <Link href="/app/me/edit?onboarding=1" className="btn btn-signal btn-lg">Living Card 만들기</Link>
      </div>
    );
  }
  return (
    <div>
      <PageHeader eyebrow={sp.group ? "Group Exchange" : "Exchange"} title={sp.group ? <>여러 명과 <em>한 번에</em></> : <>한 번의 탭으로 <em>교환</em></>} />
      <div className="mx-auto max-w-sm">
        <CardFace card={card.projectCard(profile, "owner")} size="sm" interactive={false} />
      </div>
      <ExchangeConsole group={sp.group === "1"} name={profile.name} />
    </div>
  );
}
