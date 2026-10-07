import type { Metadata } from "next";
import { GuestLanding } from "./GuestLanding";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "명함이 도착했어요", robots: { index: false, follow: false } };

// UX-005 Guest Landing — 로그인/앱설치 요구 없이 sender 3초 카드 표시 (F-053)
export default async function GuestLandingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang } = await searchParams;
  return <GuestLanding tokenOrCode={token} lang={lang} />;
}
