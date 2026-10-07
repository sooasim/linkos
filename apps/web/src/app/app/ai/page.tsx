import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { AiHub } from "./AiHub";

export const metadata: Metadata = { title: "AI 기억·매칭" };

// UX-017 AI Search + UX-018 Match
export default function AiPage() {
  return (
    <div>
      <PageHeader eyebrow="Relationship Intelligence" title={<>기억하고, <em>연결하다</em></>} />
      <AiHub />
    </div>
  );
}
