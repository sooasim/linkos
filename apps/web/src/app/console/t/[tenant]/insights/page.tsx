import { Suite } from "@/app/console/Suite";

// U-T06 · 기관 성과 집계 — spec route /t/:tenant/insights
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="insights" tenant={tenant} />;
}
