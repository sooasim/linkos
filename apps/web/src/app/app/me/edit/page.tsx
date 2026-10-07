import { card } from "@linkos/api";
import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { CardEditor } from "./CardEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "카드 편집" };

// UX-010 Card Editor
export default async function EditPage({ searchParams }: { searchParams: Promise<{ onboarding?: string; new?: string; id?: string; tab?: string }> }) {
  const sp = await searchParams;
  const { userId } = await getViewer();
  const pid = sp.new ? null : (sp.id ?? (await card.primaryProfileId(userId!)));
  const p = pid ? await card.loadProfile(pid) : null;
  if (p && p.userId !== userId) return null;
  // F-021: server-resolved design (template + glyphs) seeds the editor preview without loading the catalog/banks
  const design = p ? card.projectCard(p, "owner").design : null;
  return <CardEditor profile={p ? JSON.parse(JSON.stringify({ ...p, design })) : null} onboarding={sp.onboarding === "1"} initialTab={sp.tab === "template" ? "template" : "info"} />;
}
