import "server-only";
// F-177: the signed-in app's language is the `lk_lang` cookie (set in Settings → 언어 / Language, or by the
// guest language picker). No cookie → Korean (default).
import { cookies } from "next/headers";
import { type AppLocale, LANG_COOKIE, messagesFor, toAppLocale } from "./i18n";

export async function getLocale(): Promise<AppLocale> {
  return toAppLocale((await cookies()).get(LANG_COOKIE)?.value);
}

export async function getMessages() {
  const locale = await getLocale();
  return { locale, m: messagesFor(locale) };
}
