import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { NetworkHub } from "./NetworkHub";

export const metadata: Metadata = { title: "네트워크 검색" };

// N-015 Intent · N-016 추천 · N-017 그래프 slice · N-110 Referral Partner
// (docs/NETWORK_INTELLIGENCE.md — S07 AI Search · S08/S09 Network Map · S18 Referral Partner)
export default async function NetworkPage({ searchParams }: { searchParams: Promise<{ q?: string; tab?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <PageHeader eyebrow="Relationship Intelligence" title={<>지금 누구와 <em>연결</em>되어야 하나요?</>} />
      <NetworkHub initialQuery={sp.q ?? ""} initialTab={sp.tab === "map" || sp.tab === "partners" ? sp.tab : "search"} />
    </div>
  );
}
