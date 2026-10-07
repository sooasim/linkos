import { card } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { LivingCard } from "@/components/LivingCard";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { AccessRequests } from "./AccessRequests";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "내 Living Card" };

// UX-009 Living Card (owner view: 상대에게 보이는 모습 미리보기)
export default async function MePage() {
  const { userId } = await getViewer();
  const pid = await card.primaryProfileId(userId!);
  if (!pid) redirect("/app/me/edit?onboarding=1");
  const p = (await card.loadProfile(pid))!;
  const asBusiness = card.projectCard(p, "business");
  const profiles = await card.listMyProfiles(userId!);
  return (
    <div>
      <PageHeader
        eyebrow="Me · 교환 상대에게 보이는 모습"
        title={<>나의 <em>Living Card</em></>}
        action={
          <Link href="/app/me/edit" className="btn btn-ink !min-h-11">
            <Icon name="edit" size={17} /> 편집
          </Link>
        }
      />
      <div className="animate-rise delay-1">
        <LivingCard card={asBusiness} showActions={false} />
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link href={`/p/${p.slug}`} className="surface flex items-center justify-between p-4">
          <span>
            <span className="block text-[15px] font-semibold">공개 프로필 페이지</span>
            <span className="block text-[13px] text-[var(--fg-mute)]">/p/{p.slug} · 공개 항목만 표시</span>
          </span>
          <Icon name="eye" />
        </Link>
        <div className="surface p-4">
          <span className="block text-[15px] font-semibold">프로필 {profiles.length}개</span>
          <span className="block text-[13px] text-[var(--fg-mute)]">개인/회사/역할별로 분리할 수 있어요</span>
          <Link href="/app/me/edit?new=1" className="mt-2 inline-block text-[13px] font-semibold underline">새 프로필 추가</Link>
        </div>
      </div>
      <AccessRequests />
    </div>
  );
}
