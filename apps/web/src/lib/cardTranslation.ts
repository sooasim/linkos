// F-112 카드 번역 — shape of a reviewed card translation and how a viewer-side language pick applies it.
// Pure, no I/O. Translations are machine (AI) translations that the card owner reviewed/edited before saving.
// Only descriptive text is translated (job title, headline, short bio, Offer/Need). Name, company, e-mail, phone,
// URLs and every contact field are NEVER translated — they always come from the original card.
// Every translated string carries its source text (`src`): if the owner later edits the original, the stale
// translation is not shown (the original is shown instead) until a new translation is reviewed.

export const CARD_TRANSLATION_LANGS = ["en", "ja"] as const;
export type CardTranslationLang = (typeof CARD_TRANSLATION_LANGS)[number];

export const TRANSLATABLE_FIELDS = ["jobTitle", "headline", "bioShort"] as const;
export type TranslatableField = (typeof TRANSLATABLE_FIELDS)[number];

export interface TranslatedText {
  src: string;
  text: string;
}

export interface CardTranslation {
  fields: Partial<Record<TranslatableField, TranslatedText>>;
  offers: TranslatedText[];
  needs: TranslatedText[];
  /** ai_inferred = machine translation (reviewed by the owner); user = typed by the owner (engine unavailable) */
  provenance: "ai_inferred" | "user";
  model?: string | null;
  reviewedAt: string;
}

export type CardTranslations = Partial<Record<CardTranslationLang, CardTranslation>>;

export const isTranslationLang = (v: unknown): v is CardTranslationLang => typeof v === "string" && (CARD_TRANSLATION_LANGS as readonly string[]).includes(v);

/** Languages with a usable translation on this card. */
export function availableTranslations(translations: CardTranslations | null | undefined): CardTranslationLang[] {
  if (!translations) return [];
  return CARD_TRANSLATION_LANGS.filter((l) => {
    const t = translations[l];
    return !!t && (Object.keys(t.fields ?? {}).length > 0 || (t.offers ?? []).length > 0 || (t.needs ?? []).length > 0);
  });
}

interface TranslatableCard {
  jobTitle?: string | null;
  headline?: string | null;
  bioShort?: string | null;
  offers?: string[];
  needs?: string[];
}

/**
 * Apply a translation to a card for display. Returns the card unchanged (and `applied: false`) when no field
 * matched. Never touches name/company/fields.
 */
export function applyCardTranslation<C extends TranslatableCard>(card: C, t: CardTranslation | null | undefined): { card: C; applied: boolean } {
  if (!t) return { card, applied: false };
  let applied = false;
  const out: C = { ...card };
  for (const k of TRANSLATABLE_FIELDS) {
    const tr = t.fields?.[k];
    const cur = card[k];
    if (tr && cur && tr.src === cur && tr.text.trim()) {
      out[k] = tr.text as C[typeof k];
      applied = true;
    }
  }
  const mapList = (list: string[] | undefined, trs: TranslatedText[] | undefined) => {
    if (!list || !trs?.length) return list;
    const map = new Map(trs.filter((x) => x.text.trim()).map((x) => [x.src, x.text]));
    return list.map((s) => {
      const v = map.get(s);
      if (v) applied = true;
      return v ?? s;
    });
  };
  if (card.offers) out.offers = mapList(card.offers, t.offers);
  if (card.needs) out.needs = mapList(card.needs, t.needs);
  return { card: out, applied };
}

/** Build the editable draft from the /translate API result (`items` keyed jobTitle | headline | bioShort | offer.N | need.N). */
export function draftFromApi(
  source: { jobTitle?: string | null; headline?: string | null; bioShort?: string | null; offers: string[]; needs: string[] },
  items: Record<string, string>,
): Pick<CardTranslation, "fields" | "offers" | "needs"> {
  const fields: CardTranslation["fields"] = {};
  for (const k of TRANSLATABLE_FIELDS) {
    const src = source[k];
    if (src) fields[k] = { src, text: items[k] ?? src };
  }
  return {
    fields,
    offers: source.offers.map((src, i) => ({ src, text: items[`offer.${i}`] ?? src })),
    needs: source.needs.map((src, i) => ({ src, text: items[`need.${i}`] ?? src })),
  };
}
