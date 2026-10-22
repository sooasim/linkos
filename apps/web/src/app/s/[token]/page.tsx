import { ApiError, cardSms } from "@linkos/api";
import { pickLocale } from "@linkos/domain";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { getViewer } from "@/lib/server";
import { LinkState } from "../../x/[token]/LinkState";
import { SmsCardLanding } from "./SmsCardLanding";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "명함이 도착했어요", robots: { index: false, follow: false } };

// X-009 문자로 받은 명함 — 로그인·앱설치 없이 열리고, 한 번 눌러 연락처로 저장하면 끝난다(§2.1).
export default async function SmsCardPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang } = await searchParams;
  const h = await headers();
  const locale = pickLocale(h.get("accept-language"), lang ?? (await cookies()).get("lk_lang")?.value);
  const { ctx } = await getViewer();
  try {
    const landing = await cardSms.openCardSmsLanding(token, ctx, { gpc: h.get("sec-gpc"), dnt: h.get("dnt") });
    return <SmsCardLanding landing={JSON.parse(JSON.stringify(landing))} locale={locale} />;
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "error";
    return <LinkState code={code === "link_expired" ? "exchange_expired" : code === "link_revoked" ? "exchange_revoked" : code} locale={locale} />;
  }
}
