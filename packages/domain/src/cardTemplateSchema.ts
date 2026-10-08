// X-008 / F-022 — card template SCHEMA, font tokens and color helpers (no catalog data).
// Kept separate from the 50-template catalog so the card renderer on the guest landing (/x/[token]) imports only
// this small module; the catalog, gallery and icon/emoji banks are lazy-loaded elsewhere.
// Pure (no I/O). Import "@linkos/domain/cardTemplateSchema".

export const TEMPLATE_CATEGORIES = ["classic", "modern", "minimal", "luxury", "creative", "industry", "korean", "pastel"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, { ko: string; en: string }> = {
  classic: { ko: "클래식", en: "Classic" },
  modern: { ko: "모던", en: "Modern" },
  minimal: { ko: "미니멀", en: "Minimal" },
  luxury: { ko: "럭셔리", en: "Luxury" },
  creative: { ko: "크리에이티브", en: "Creative" },
  industry: { ko: "업종별", en: "Industry" },
  korean: { ko: "한국 전통", en: "Korean" },
  pastel: { ko: "파스텔", en: "Pastel" },
};

/** ~8 layout archetypes; every template picks one and a single renderer draws them all. */
export const TEMPLATE_LAYOUTS = ["classic", "centered", "split", "rail", "band", "stack", "monogram", "grid"] as const;
export type TemplateLayout = (typeof TEMPLATE_LAYOUTS)[number];

/** Font roles. serif/sans/kr are the app's bundled fonts; the rest are local system font STACKS (no network loads). */
export const FONT_ROLES = ["serif", "sans", "kr", "mono", "didone", "kr-serif"] as const;
export type FontRole = (typeof FONT_ROLES)[number];
export const FONT_STACKS: Record<FontRole, string> = {
  serif: 'var(--font-serif), "Instrument Serif", ui-serif, Georgia, "Nanum Myeongjo", serif',
  sans: 'var(--font-inter), "Inter Tight", "Pretendard Variable", Pretendard, system-ui, sans-serif',
  kr: '"Pretendard Variable", Pretendard, var(--font-inter), -apple-system, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", "D2Coding", monospace',
  didone: '"Bodoni 72", Didot, "Bodoni MT", "Times New Roman", "Nanum Myeongjo", ui-serif, serif',
  "kr-serif": '"Nanum Myeongjo", AppleMyungjo, "Noto Serif KR", Batang, ui-serif, Georgia, serif',
};

export type RuleStyle = "none" | "hairline" | "double" | "thick" | "dotted";
export type MonogramShape = "none" | "plain" | "circle" | "square" | "diamond" | "crest";

export interface CardTemplate {
  id: string;
  name: { ko: string; en: string };
  category: TemplateCategory;
  orientation: "landscape" | "portrait";
  layout: TemplateLayout;
  palette: {
    bg: string; // dominant paper color
    fg: string; // primary text (must be AA ≥ 4.5 on every opaque background stop)
    accent: string; // rules, monogram, emphasised text (AA ≥ 4.5 on bg)
    muted: string; // secondary text (AA ≥ 4.5 on every opaque background stop)
    onAccent: string; // text drawn on accent/block areas (AA ≥ 4.5 on accent and block stops)
  };
  /** Allowed accent overrides; the first equals palette.accent. */
  accentOptions: string[];
  background: {
    /** CSS `background` value: colors and gradients only (no url()). Hex colors = opaque stops; rgba() = translucent overlays. */
    css: string;
    /** Optional inline SVG drawn as a decorative layer (data URI, never fetched). */
    pattern?: string;
    patternMode?: "tile" | "cover";
    /** tile width in % of card width (tile mode) */
    patternSize?: number;
  };
  /** Optional CSS for block areas (split/rail/band); defaults to the accent color. */
  block?: string;
  /** Optional decorative stripe (top edge), purely ornamental, never carries text. */
  stripe?: string;
  typography: {
    display: FontRole;
    body: FontRole;
    nameWeight: 400 | 500 | 600 | 700 | 800;
    nameCase: "none" | "upper";
    /** letter-spacing of the name in em */
    nameTracking: number;
    /** 1 = default name size for the layout */
    nameScale: number;
    italic: boolean;
  };
  decoration: {
    rule: RuleStyle;
    corners: boolean;
    frame: "none" | "inset" | "double";
    /** metallic/holo gradient stops on the name (each ≥ 3:1 on bg — large text) */
    foil: string[] | null;
    emboss: boolean;
    monogram: MonogramShape;
    texture: "none" | "grain";
    glow: boolean;
    /** frosted glass panel behind the text */
    panel: boolean;
    /** corner radius in % of card width */
    radius: number;
  };
  show: { company: boolean; jobTitle: boolean; headline: boolean; keywords: boolean; contacts: 0 | 1 | 2 | 3; icon: boolean };
  /** topic + style keys for suggestTemplates/search (see TOPIC_SYNONYMS) */
  tags: string[];
}


// ── color / contrast (WCAG 2.x) ─────────────────────────────────────────
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`bad color ${hex}`);
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Mix two hex colors (t=0 → a, t=1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a)!;
  const y = parseHex(b)!;
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
/** All opaque hex stops mentioned in a CSS background recipe. */
export function opaqueStops(css: string): string[] {
  return Array.from(new Set((css.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? []).map((s) => s.toUpperCase())));
}

const HANGUL_RE = /[가-힣]/;

/** Initials for monograms: Hangul names → family name syllable; latin → first+last initials. */
export function initialsFor(name: string): string {
  const s = name.trim();
  if (!s) return "";
  if (HANGUL_RE.test(s[0]!)) return s[0]!;
  const parts = s.split(/\s+/).filter(Boolean);
  const first = Array.from(parts[0] ?? "")[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? "") : "";
  return (first + last).toUpperCase();
}

