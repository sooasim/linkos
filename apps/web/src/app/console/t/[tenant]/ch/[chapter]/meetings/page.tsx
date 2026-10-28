import { Suite } from "@/app/console/Suite";

// U-C03 · 모임·출석 — spec route /t/:tenant/ch/:chapter/meetings
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="meetings" tenant={tenant} chapter={chapter} />;
}
