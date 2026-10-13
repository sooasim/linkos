import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { OpportunityBoard } from "./OpportunityBoard";

export const metadata: Metadata = { title: "기회" };

// N-021 Opportunity 파이프라인 (S12 Opportunity Board)
export default function OpportunitiesPage() {
  return (
    <div>
      <PageHeader eyebrow="Opportunities" title={<>탐지된 <em>기회</em>를 끝까지</>} />
      <OpportunityBoard />
    </div>
  );
}
