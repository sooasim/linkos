import { GUEST_MESSAGES, type Locale } from "@linkos/domain";
import Link from "next/link";
import { Logo } from "@/components/Icon";

export function LinkState({ code, locale = "ko" }: { code: string; locale?: Locale }) {
  const m = GUEST_MESSAGES[locale];
  const COPY: Record<string, { title: string; body: string }> = {
    exchange_expired: { title: m.linkExpiredT, body: m.linkExpiredB },
    exchange_revoked: { title: m.linkRevokedT, body: m.linkRevokedB },
    not_found: { title: m.notFoundT, body: m.notFoundB },
    rate_limited: { title: m.rateLimitedT, body: m.rateLimitedB },
  };
  const c = COPY[code] ?? { title: m.errorT, body: m.errorB };
  return (
    <main lang={locale} className="stage-aurora grain flex min-h-dvh flex-col px-6 pb-10 pt-6">
      <div aria-hidden className="marks" />
      <Logo />
      <div className="my-auto max-w-md animate-rise">
        <p className="eyebrow">LINKOS Exchange</p>
        <h1 className="display mt-3 text-[56px]">{c.title}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-[var(--fg-mute)]">{c.body}</p>
        <div className="mt-8 flex gap-3">
          <Link href="/c" className="btn btn-signal">{m.receiveByCode}</Link>
          <Link href="/" className="btn btn-ghost">{m.learnMore}</Link>
        </div>
      </div>
    </main>
  );
}
