import type { Metadata } from "next";
import { GuestLanding } from "../../x/[token]/GuestLanding";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "명함이 도착했어요", robots: { index: false, follow: false } };

// F-045 단축코드 수신: /c/1234 → 동일한 게스트 랜딩
export default async function ShortCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <GuestLanding tokenOrCode={code} />;
}
