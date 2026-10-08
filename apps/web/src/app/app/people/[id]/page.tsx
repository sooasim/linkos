import type { Metadata } from "next";
import { PersonDetail } from "./PersonDetail";
import { StrengthPanel } from "./StrengthPanel";

export const metadata: Metadata = { title: "인맥 상세" };

// UX-012 Person Detail + UX-013 Merge Review + F-074 관계 강도
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PersonDetail id={id} />
      <StrengthPanel id={id} />
    </>
  );
}
