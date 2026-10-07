import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { ClaimFlow } from "./ClaimFlow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "내 카드 소유하기", robots: { index: false } };

// UX-008 Claim — 교환 후에만 등장 (F-003, F-061)
export default async function ClaimPage() {
  const { userId } = await getViewer();
  return <ClaimFlow signedIn={!!userId} />;
}
