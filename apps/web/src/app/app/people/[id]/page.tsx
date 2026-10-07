import type { Metadata } from "next";
import { PersonDetail } from "./PersonDetail";

export const metadata: Metadata = { title: "인맥 상세" };

// UX-012 Person Detail + UX-013 Merge Review
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonDetail id={id} />;
}
