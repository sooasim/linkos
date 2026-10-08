import { apple, identity, integration } from "@linkos/api";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMessages } from "@/lib/i18n.server";
import { getViewer, safeNext } from "@/lib/server";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).m.login.signIn };
}

// UX-008 Claim / 로그인: Google · Apple · 이메일 OTP (비밀번호 없음)
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const { userId } = await getViewer();
  if (userId) redirect(next);
  return (
    <LoginForm
      next={next}
      google={integration.googleEnabled()}
      googleConsent={sp.consent === "google"}
      apple={apple.appleEnabled()}
      appleConsent={sp.consent === "apple"}
      ssoConsent={sp.consent === "sso"}
      error={sp.error ?? null}
      oneTapClientId={identity.oneTapEnabled() ? (process.env.GOOGLE_CLIENT_ID ?? null) : null}
      demoLogin={identity.demoLoginEnabled()}
      mailConfigured={identity.mailConfigured()}
    />
  );
}
