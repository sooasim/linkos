import { Suite } from "@/app/console/Suite";

// U-T02 · 다중챕터 관리 — spec route /t/:tenant/chapters
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="chapters" tenant={tenant} />;
}
