// F-021 card decoration + F-036 action CTA icons — template options, glyph references, validation, resolution.
// Server-side resolution turns ids into render-ready data (SVG path / emoji char) so the guest landing renderer
// never needs the 50-template catalog or the icon/emoji banks in its bundle.
// Pure (no I/O). NOT re-exported from the package index — import "@linkos/domain/cardDesign".
import { type CardTemplate, getCardTemplate, parseHex } from "./cardTemplates";
import { getBankEmoji, graphemeCount, isBankEmoji } from "./emojiBank";
import { getBankIcon } from "./iconBank";

/** "i:<iconId>" (line icon from the bank) or "e:<emoji>" (single grapheme from the emoji bank). */
export type GlyphRef = string;

export const DEEP_SECTIONS = ["projects", "achievements", "services", "assets", "network", "interests", "languages", "certifications"] as const;
export type DeepSection = (typeof DEEP_SECTIONS)[number];
export const CTA_KINDS = ["booking", "quote", "proposal", "nda"] as const;
export const ICON_FIELD_TYPES = ["email", "phone", "mobile", "website", "address", "linkedin", "instagram", "x", "github", "kakao", "booking", "other"] as const;

export interface CardTemplateOptions {
  /** accent override — must be one of the template's accentOptions */
  accent?: string;
  /** monogram / initials text: 1–3 letters or Hangul syllables */
  monogram?: string;
  /** logo / monogram icon on the card face */
  icon?: GlyphRef;
  /** per contact field type */
  fieldIcons?: Partial<Record<string, GlyphRef>>;
  /** keyword → badge glyph (keywords are max 3) */
  keywordBadges?: Record<string, GlyphRef>;
  /** deep-profile section header glyphs */
  sectionIcons?: Partial<Record<DeepSection, GlyphRef>>;
}

export type ResolvedGlyph = { kind: "icon"; ref: GlyphRef; d: string; label: string } | { kind: "emoji"; ref: GlyphRef; char: string; label: string };

export interface ResolvedCardDesign {
  template: CardTemplate | null;
  accent: string | null;
  monogram: string | null;
  icon: ResolvedGlyph | null;
  fieldIcons: Record<string, ResolvedGlyph>;
  keywordBadges: Record<string, ResolvedGlyph>;
  sectionIcons: Record<string, ResolvedGlyph>;
}

export function resolveGlyph(ref: unknown): ResolvedGlyph | null {
  if (typeof ref !== "string" || ref.length < 3 || ref.length > 40) return null;
  if (ref.startsWith("i:")) {
    const icon = getBankIcon(ref.slice(2));
    return icon ? { kind: "icon", ref, d: icon.d, label: icon.ko[0] ?? icon.id } : null;
  }
  if (ref.startsWith("e:")) {
    const char = ref.slice(2);
    if (!isBankEmoji(char)) return null;
    const e = getBankEmoji(char)!;
    return { kind: "emoji", ref, char, label: e.ko[0] ?? e.en[0] ?? char };
  }
  return null;
}

export function isValidGlyph(ref: unknown): boolean {
  return resolveGlyph(ref) !== null;
}

const MONOGRAM = /^[A-Za-z0-9가-힣&.]+$/u;

/**
 * Semantic validation of template id + options (shape is validated by the API's zod schema).
 * Returns a list of error codes; empty = valid.
 */
export function validateCardDesign(templateId: string | null | undefined, options: CardTemplateOptions | null | undefined): string[] {
  const errs: string[] = [];
  const tpl = templateId ? getCardTemplate(templateId) : undefined;
  if (templateId && !tpl) errs.push("unknown_template");
  const o = options ?? {};
  if (o.accent !== undefined) {
    if (!parseHex(o.accent)) errs.push("accent_format");
    else if (!tpl) errs.push("accent_without_template");
    else if (!tpl.accentOptions.some((a) => a.toUpperCase() === o.accent!.toUpperCase())) errs.push("accent_not_allowed");
  }
  if (o.monogram !== undefined) {
    const m = o.monogram.trim();
    if (!m || graphemeCount(m) > 3 || !MONOGRAM.test(m)) errs.push("monogram_invalid");
  }
  if (o.icon !== undefined && !isValidGlyph(o.icon)) errs.push("icon_unknown");
  for (const [k, v] of Object.entries(o.fieldIcons ?? {})) {
    if (!(ICON_FIELD_TYPES as readonly string[]).includes(k)) errs.push(`field_icon_type:${k}`);
    if (!isValidGlyph(v)) errs.push(`field_icon_unknown:${k}`);
  }
  const kb = Object.entries(o.keywordBadges ?? {});
  if (kb.length > 3) errs.push("keyword_badges_max");
  for (const [k, v] of kb) {
    if (!k.trim() || k.length > 30) errs.push("keyword_badge_key");
    if (!isValidGlyph(v)) errs.push(`keyword_badge_unknown:${k}`);
  }
  for (const [k, v] of Object.entries(o.sectionIcons ?? {})) {
    if (!(DEEP_SECTIONS as readonly string[]).includes(k)) errs.push(`section_icon_key:${k}`);
    if (!isValidGlyph(v)) errs.push(`section_icon_unknown:${k}`);
  }
  return errs;
}

function resolveMap(m: Record<string, unknown> | undefined): Record<string, ResolvedGlyph> {
  const out: Record<string, ResolvedGlyph> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    const g = resolveGlyph(v);
    if (g) out[k] = g;
  }
  return out;
}

/** Render-ready design (or null when the card uses no template and no decorations). Unknown ids are dropped. */
export function resolveCardDesign(templateId: string | null | undefined, options: CardTemplateOptions | null | undefined): ResolvedCardDesign | null {
  const template = getCardTemplate(templateId) ?? null;
  const o = options ?? {};
  const accent = template && o.accent && template.accentOptions.some((a) => a.toUpperCase() === o.accent!.toUpperCase()) ? o.accent : null;
  const d: ResolvedCardDesign = {
    template,
    accent,
    monogram: o.monogram?.trim() || null,
    icon: resolveGlyph(o.icon),
    fieldIcons: resolveMap(o.fieldIcons),
    keywordBadges: resolveMap(o.keywordBadges),
    sectionIcons: resolveMap(o.sectionIcons),
  };
  const empty = !d.template && !d.icon && !d.monogram && !Object.keys(d.fieldIcons).length && !Object.keys(d.keywordBadges).length && !Object.keys(d.sectionIcons).length;
  return empty ? null : d;
}
