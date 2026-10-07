import { card } from "@linkos/api";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileMediaManager } from "@/components/ProfileMedia";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "포트폴리오 · 파일" };

// F-024 딥 프로필: 성과/포트폴리오/미디어/파일
export default async function MediaPage() {
  const { userId } = await getViewer();
  const profileId = userId ? await card.primaryProfileId(userId) : null;
  if (!profileId) redirect("/app/me/edit");
  return (
    <div>
      <PageHeader back="/app/me" eyebrow="Living Card · Deep" title={<>포트폴리오 <em>파일</em></>} />
      <ProfileMediaManager profileId={profileId} />
    </div>
  );
}
