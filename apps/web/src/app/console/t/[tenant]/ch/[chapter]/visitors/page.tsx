import { Suite } from "@/app/console/Suite";

// U-C05 · 방문자 운영 — spec route /t/:tenant/ch/:chapter/visitors
export default async function Page({ params }: { params: Promise<{ tenant: string; chapter: string }> }) {
  const { tenant, chapter } = await params;
  return <Suite role="chapter" page="visitors" tenant={tenant} chapter={chapter} />;
}
