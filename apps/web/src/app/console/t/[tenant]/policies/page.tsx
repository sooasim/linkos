import { Suite } from "@/app/console/Suite";

// U-T04 · 운영 정책·권한 — spec route /t/:tenant/policies
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="policies" tenant={tenant} />;
}
