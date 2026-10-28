import { Suite } from "@/app/console/Suite";

// U-T03 · 기관 구독·청구 — spec route /t/:tenant/billing
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="billing" tenant={tenant} />;
}
