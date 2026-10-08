"use client";
// F-177: client-side access to the app dictionary. The locale comes from the root layout (cookie `lk_lang`).
import Link from "next/link";
import { createContext, useContext } from "react";
import { type AppLocale, type AppMessages, LANG_COOKIE, messagesFor } from "@/lib/i18n";
import { Icon } from "./Icon";

const I18nContext = createContext<AppLocale>("ko");

export function I18nProvider({ locale, children }: { locale: AppLocale; children: React.ReactNode }) {
  return <I18nContext.Provider value={locale}>{children}</I18nContext.Provider>;
}

export function useI18n(): { locale: AppLocale; m: AppMessages } {
  const locale = useContext(I18nContext);
  return { locale, m: messagesFor(locale) };
}

/** Persist the language choice for this browser (1 year). Same cookie the guest language picker writes. */
export function setLangCookie(l: AppLocale) {
  document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
}

/** Localized "뒤로 / Back" link used by PageHeader (PageHeader itself stays usable from server components). */
export function BackLink({ href }: { href: string }) {
  const { m } = useI18n();
  return (
    <Link href={href} className="mb-4 inline-flex items-center gap-1 text-[14px] font-medium text-[var(--fg-mute)] hover:text-[var(--fg)]">
      <Icon name="back" size={16} /> {m.common.back}
    </Link>
  );
}
