import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { PathCompare } from "./PathCompare";

export const metadata: Metadata = { title: "소개 경로 비교" };

// N-105 Top-K 소개 경로 (S16 Alternative Path Compare · S11 Introduction Path)
export default async function PathsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  return (
    <div>
      <PageHeader eyebrow="Introduction Paths" title={<>어떤 <em>경로</em>로 소개받을까요?</>} back="/app/network" />
      <PathCompare contactId={contactId} />
    </div>
  );
}
