"use client";
// F-177 다국어 — Settings → 언어 / Language. Stored in the `lk_lang` cookie (this browser); the server reads it for
// <html lang> and the translated shell. Korean is the default.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLangCookie, useI18n } from "@/components/I18n";
import { Icon } from "@/components/Icon";
import { APP_LOCALES, type AppLocale } from "@/lib/i18n";

export function LanguageSettings() {
  const router = useRouter();
  const { locale, m } = useI18n();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const choose = (l: AppLocale) => {
    if (l === locale) return;
    setLangCookie(l);
    setDone(true);
    start(() => router.refresh());
  };
  return (
    <section className="surface mb-4 space-y-3 p-5" aria-labelledby="lang-title" data-testid="language-settings">
      <h2 id="lang-title" className="flex items-center gap-2 text-[17px] font-semibold"><Icon name="globe" size={19} />{m.lang.title}</h2>
      <p className="text-[13.5px] text-[var(--fg-mute)]">{m.lang.body}</p>
      <div role="radiogroup" aria-label={m.lang.title} className="flex flex-wrap gap-2">
        {APP_LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={locale === l}
            lang={l}
            disabled={pending}
            onClick={() => choose(l)}
            data-testid={`lang-${l}`}
            className={`chip !min-h-10 !px-4 text-[14px] ${locale === l ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}
          >
            {locale === l && <Icon name="check" size={14} />}
            {m.lang[l]}
          </button>
        ))}
      </div>
      {done && !pending && <p role="status" className="text-[13px] text-[var(--fg-mute)]">{m.lang.saved}</p>}
    </section>
  );
}
