import { Suite } from "@/app/console/Suite";

// U-C01 · 챕터 운영 홈 — spec route /t/:tenant/ch/:chapter/dashboard
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="home" tenant={tenant} chapter={chapter} />;
}
