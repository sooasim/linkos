import { growth } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/Page";
import { slot } from "@/lib/i18n";
import { getMessages } from "@/lib/i18n.server";
import { getViewer } from "@/lib/server";
import { AccountExtras } from "./AccountExtras";
import { AssistantPrefs } from "./AssistantPrefs";
import { LanguageSettings } from "./LanguageSettings";
import { Settings } from "./Settings";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).m.nav.settings };
}
export const dynamic = "force-dynamic";

// UX-022 Integrations + UX-023 Export + Privacy + F-006 Passkey + F-064 Referral + F-137/F-166 내 활동 기록 · 동기화 대기열 링크 + F-177 언어
export default async function SettingsPage() {
  const { userId } = await getViewer();
  const admin = await growth.isAdmin(userId);
  const S = (await getMessages()).m.settings;
  return (
    <div>
      <PageHeader eyebrow="Settings" title={<>{slot(S.title)[0]}<em>{S.titleEm}</em>{slot(S.title)[1]}</>} />
      <nav aria-label={S.accountMenu} className="mb-4 flex flex-wrap gap-2">
        <Link href="/app/inbox" className="btn btn-ghost"><Icon name="mail" size={18} /> {S.inbox}</Link>
        <Link href="/app/billing" className="btn btn-ghost"><Icon name="bolt" size={18} /> {S.billing}</Link>
        <Link href="/app/sync" className="btn btn-ghost"><Icon name="layers" size={18} /> {S.syncQueue}</Link>
        {admin && <Link href="/app/admin" className="btn btn-ghost"><Icon name="chart" size={18} /> {S.admin}</Link>}
      </nav>
      <LanguageSettings />
      <Settings />
      <AssistantPrefs />
      <AccountExtras />
    </div>
  );
}
