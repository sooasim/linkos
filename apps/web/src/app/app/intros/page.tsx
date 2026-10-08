import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { IntrosHub } from "./IntrosHub";

export const metadata: Metadata = { title: "소개" };

// 소개와 Connection Room (백서 19)
export default async function IntrosPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <PageHeader eyebrow="Introductions" title={<>동의 기반 <em>소개</em></>} />
      <IntrosHub preA={sp.a ?? null} />
    </div>
  );
}
