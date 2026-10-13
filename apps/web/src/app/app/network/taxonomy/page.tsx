import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { AliasEditor } from "./AliasEditor";

export const metadata: Metadata = { title: "분류 별칭" };

// N-107 다국어 분류/별칭 — 사전에 없는 사내 표현을 canonical 분류값으로 흡수한다
export default async function TaxonomyPage({ searchParams }: { searchParams: Promise<{ alias?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <PageHeader eyebrow="Taxonomy" title={<>우리가 쓰는 <em>말</em>로 검색하기</>} back="/app/network" />
      <AliasEditor initialAlias={sp.alias ?? ""} />
    </div>
  );
}
