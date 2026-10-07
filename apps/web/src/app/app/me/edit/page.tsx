import { card } from "@linkos/api";
import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { CardEditor } from "./CardEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "카드 편집" };

// UX-010 Card Editor
export default async function EditPage({ searchParams }: { searchParams: Promise<{ onboarding?: string; new?: string; id?: string }> }) {
  const sp = await searchParams;
  const { userId } = await getViewer();
  const pid = sp.new ? null : (sp.id ?? (await card.primaryProfileId(userId!)));
  const p = pid ? await card.loadProfile(pid) : null;
  if (p && p.userId !== userId) return null;
  return <CardEditor profile={p ? JSON.parse(JSON.stringify(p)) : null} onboarding={sp.onboarding === "1"} />;
}
