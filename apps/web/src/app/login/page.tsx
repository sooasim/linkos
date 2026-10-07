import { integration } from "@linkos/api";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer, safeNext } from "@/lib/server";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "로그인" };

// UX-008 Claim / 로그인: Google · 이메일 OTP (비밀번호 없음)
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const { userId } = await getViewer();
  if (userId) redirect(next);
  return <LoginForm next={next} google={integration.googleEnabled()} googleConsent={sp.consent === "google"} ssoConsent={sp.consent === "sso"}error={sp.error ?? null} />;
}
