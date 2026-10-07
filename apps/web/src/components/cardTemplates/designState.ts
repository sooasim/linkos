// F-021 — client-side design state for the editor/gallery (no catalog or bank import: templates and glyphs arrive
// already resolved, from the server or from the lazily-loaded gallery / picker).
import type { CardTemplateOptions, ResolvedCardDesign, ResolvedGlyph } from "@linkos/domain/cardDesign";
import type { CardTemplate } from "@linkos/domain/cardTemplateSchema";

export interface DesignState {
  template: CardTemplate | null;
  options: CardTemplateOptions;
  /** ref ("i:…" / "e:…") → resolved glyph, for preview */
  glyphs: Record<string, ResolvedGlyph>;
}

export function initialDesignState(design: ResolvedCardDesign | null | undefined, options: CardTemplateOptions | null | undefined): DesignState {
  const glyphs: Record<string, ResolvedGlyph> = {};
  const add = (g: ResolvedGlyph | null | undefined) => {
    if (g) glyphs[g.ref] = g;
  };
  add(design?.icon);
  for (const m of [design?.fieldIcons, design?.keywordBadges, design?.sectionIcons]) for (const g of Object.values(m ?? {})) add(g);
  return { template: design?.template ?? null, options: { ...(options ?? {}) }, glyphs };
}

function mapGlyphs(m: Record<string, string | undefined> | undefined, glyphs: Record<string, ResolvedGlyph>) {
  const out: Record<string, ResolvedGlyph> = {};
  for (const [k, ref] of Object.entries(m ?? {})) if (ref && glyphs[ref]) out[k] = glyphs[ref]!;
  return out;
}

export function designFromState(s: DesignState): ResolvedCardDesign | null {
  const icon = s.options.icon ? (s.glyphs[s.options.icon] ?? null) : null;
  const d: ResolvedCardDesign = {
    template: s.template,
    accent: s.template && s.options.accent ? s.options.accent : null,
    monogram: s.options.monogram?.trim() || null,
    icon,
    fieldIcons: mapGlyphs(s.options.fieldIcons, s.glyphs),
    keywordBadges: mapGlyphs(s.options.keywordBadges, s.glyphs),
    sectionIcons: mapGlyphs(s.options.sectionIcons, s.glyphs),
  };
  return d;
}

/** Options payload for the API: drops empties and accents the current template does not allow. */
export function cleanOptions(s: DesignState, keywords: string[] = []): CardTemplateOptions {
  const o: CardTemplateOptions = {};
  const tpl = s.template;
  if (tpl && s.options.accent && tpl.accentOptions.some((a) => a.toUpperCase() === s.options.accent!.toUpperCase())) o.accent = s.options.accent;
  if (s.options.monogram?.trim()) o.monogram = s.options.monogram.trim();
  if (s.options.icon) o.icon = s.options.icon;
  const nonEmpty = <T extends Record<string, string | undefined>>(m: T | undefined, keep?: (k: string) => boolean) => {
    const e = Object.entries(m ?? {}).filter(([k, v]) => v && (!keep || keep(k)));
    return e.length ? (Object.fromEntries(e) as Record<string, string>) : undefined;
  };
  const fi = nonEmpty(s.options.fieldIcons);
  if (fi) o.fieldIcons = fi;
  const kb = nonEmpty(s.options.keywordBadges, (k) => keywords.includes(k));
  if (kb) o.keywordBadges = kb;
  const si = nonEmpty(s.options.sectionIcons);
  if (si) o.sectionIcons = si as CardTemplateOptions["sectionIcons"];
  return o;
}

export function withGlyph(s: DesignState, g: ResolvedGlyph | null): DesignState {
  return g ? { ...s, glyphs: { ...s.glyphs, [g.ref]: g } } : s;
}
