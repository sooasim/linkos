import { card, event } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { CardFace } from "@/components/LivingCard";
import { PageHeader } from "@/components/Page";
import { slot } from "@/lib/i18n";
import { getMessages } from "@/lib/i18n.server";
import { getViewer } from "@/lib/server";
import { ExchangeConsole } from "./ExchangeConsole";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).m.nav.exchange };
}

// UX-002 Exchange Start + UX-004 Share Handoff; F-143 현장 교환 (?event={id} tags the session with the event)
export default async function ExchangePage({ searchParams }: { searchParams: Promise<{ group?: string; event?: string }> }) {
  const { userId, ctx } = await getViewer();
  const X = (await getMessages()).m.exchange; // F-177 ko/en
  const sp = await searchParams;
  const pid = await card.primaryProfileId(userId!);
  const profile = pid ? await card.loadProfile(pid) : null;
  if (!profile) {
    return (
      <div>
        <PageHeader eyebrow="Exchange" title={<>{slot(X.needCard)[0]}<em>{X.needCardEm}</em>{slot(X.needCard)[1]}</>} />
        <Link href="/app/me/edit?onboarding=1" className="btn btn-signal btn-lg">{X.makeCard}</Link>
      </div>
    );
  }
  // only events the viewer attends can tag an exchange (the API enforces the same rule)
  const ev = sp.event && /^[0-9a-f-]{36}$/i.test(sp.event) ? await event.getEvent(ctx, sp.event).catch(() => null) : null;
  return (
    <div>
      <PageHeader eyebrow={sp.group ? "Group Exchange" : ev ? "Event Exchange" : "Exchange"} title={sp.group ? <>{slot(X.groupTitle)[0]}<em>{X.groupEm}</em>{slot(X.groupTitle)[1]}</> : <>{slot(X.title)[0]}<em>{X.titleEm}</em>{slot(X.title)[1]}</>} />
      <div className="mx-auto max-w-sm">
        <CardFace card={card.projectCard(profile, "owner")} size="sm" interactive={false} />
      </div>
      <ExchangeConsole group={sp.group === "1"} name={profile.name} event={ev ? { id: ev.id, name: ev.name } : null} />
    </div>
  );
}
