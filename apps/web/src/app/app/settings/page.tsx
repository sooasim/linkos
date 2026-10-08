import { growth } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { AccountExtras } from "./AccountExtras";
import { AssistantPrefs } from "./AssistantPrefs";
import { Settings } from "./Settings";

export const metadata: Metadata = { title: "설정·연동" };
export const dynamic = "force-dynamic";

// UX-022 Integrations + UX-023 Export + Privacy + F-006 Passkey + F-064 Referral + F-137/F-166 내 활동 기록 · 동기화 대기열 링크
export default async function SettingsPage() {
  const { userId } = await getViewer();
  const admin = await growth.isAdmin(userId);
  return (
    <div>
      <PageHeader eyebrow="Settings" title={<>연동 · 내보내기 · <em>개인정보</em></>} />
      <nav aria-label="계정 메뉴" className="mb-4 flex flex-wrap gap-2">
        <Link href="/app/inbox" className="btn btn-ghost"><Icon name="mail" size={18} /> 알림함</Link>
        <Link href="/app/billing" className="btn btn-ghost"><Icon name="bolt" size={18} /> 플랜·결제</Link>
        <Link href="/app/sync" className="btn btn-ghost"><Icon name="layers" size={18} /> 동기화 대기열</Link>
        {admin && <Link href="/app/admin" className="btn btn-ghost"><Icon name="chart" size={18} /> 관리자</Link>}
      </nav>
      <Settings />
      <AssistantPrefs />
      <AccountExtras />
    </div>
  );
}
