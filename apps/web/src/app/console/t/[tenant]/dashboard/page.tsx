import { Suite } from "@/app/console/Suite";

// U-T01 · 기관 대시보드 — spec route /t/:tenant/dashboard
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="home" tenant={tenant} />;
}
