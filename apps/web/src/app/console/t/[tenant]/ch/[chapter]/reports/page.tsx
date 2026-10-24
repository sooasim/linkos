import { Suite } from "@/app/console/Suite";

// U-C06 · 챕터 보고서 — spec route /t/:tenant/ch/:chapter/reports
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="reports" tenant={tenant} chapter={chapter} />;
}
