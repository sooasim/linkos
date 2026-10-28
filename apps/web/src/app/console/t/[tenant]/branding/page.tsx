import { Suite } from "@/app/console/Suite";

// U-T05 · 화이트라벨 브랜드 — spec route /t/:tenant/branding
export default async function Page({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return <Suite role="tenant" page="branding" tenant={tenant} />;
}
