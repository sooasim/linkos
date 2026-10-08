import { card } from "@linkos/api";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { TemplatesClient } from "./TemplatesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "명함 템플릿" };

// X-008 / F-022 full-screen template gallery: 50 templates, live preview with my card, apply → guest landing/public profile
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const sp = await searchParams;
  const { userId } = await getViewer();
  const pid = sp.id ?? (userId ? await card.primaryProfileId(userId) : null);
  if (!pid) redirect("/app/me/edit?onboarding=1");
  const p = await card.loadProfile(pid);
  if (!p || p.userId !== userId) redirect("/app/me");
  const asBusiness = card.projectCard(p, "business");
  return (
    <div>
      <PageHeader back="/app/me" eyebrow="Card Studio · 50 templates" title={<>명함 <em>템플릿</em></>} />
      <TemplatesClient
        profileId={p.id}
        version={p.version}
        options={JSON.parse(JSON.stringify(p.templateOptions))}
        card={JSON.parse(JSON.stringify({ ...asBusiness, industries: p.industries, bioShort: p.bioShort }))}
      />
    </div>
  );
}
