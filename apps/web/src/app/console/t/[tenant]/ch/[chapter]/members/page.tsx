import { Suite } from "@/app/console/Suite";

// U-C02 · 회원·심사 — spec route /t/:tenant/ch/:chapter/members
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="members" tenant={tenant} chapter={chapter} />;
}
