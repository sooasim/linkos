import { Suite } from "@/app/console/Suite";

// U-C04 · 소개 후속관리 — spec route /t/:tenant/ch/:chapter/referrals
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="referrals" tenant={tenant} chapter={chapter} />;
}
