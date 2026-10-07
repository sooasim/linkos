// X-008 / F-022 — Living Card design templates (50 original templates as DATA, rendered by one component).
// Each template is inspired by a recognizable professional card-design *style* (Swiss grid, letterpress, art-deco …)
// and is an original composition: no real company's card, logo, trade dress or name is reproduced.
// Explicit colors are allowed here because the card is a printed object, not app chrome.
// Pure (no I/O). NOT re-exported from the package index — import "@linkos/domain/cardTemplates".
import {
  type CardTemplate,
  FONT_ROLES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  TEMPLATE_LAYOUTS,
  type TemplateCategory,
  contrastRatio,
  opaqueStops,
} from "./cardTemplateSchema";

export * from "./cardTemplateSchema";

// ── builder ─────────────────────────────────────────────────────────────
type Partial2<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Partial<T[K]>) : T[K] };
type Def = Omit<Partial2<CardTemplate>, "palette"> & Pick<CardTemplate, "id" | "name" | "category" | "layout" | "tags"> & {
  palette: Omit<CardTemplate["palette"], "onAccent"> & { onAccent?: string };
  extraAccents?: string[];
};

const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

function t(d: Def): CardTemplate {
  const { extraAccents = [], ...rest } = d;
  return {
    orientation: "landscape",
    ...rest,
    palette: { onAccent: d.palette.bg, ...d.palette },
    accentOptions: [d.palette.accent, ...extraAccents],
    background: { css: d.palette.bg, ...(d.background ?? {}) },
    typography: { display: "serif", body: "sans", nameWeight: 400, nameCase: "none", nameTracking: -0.01, nameScale: 1, italic: false, ...(d.typography ?? {}) },
    decoration: { rule: "none", corners: false, frame: "none", foil: null, emboss: false, monogram: "none", texture: "none", glow: false, panel: false, radius: 2.6, ...(d.decoration ?? {}) },
    show: { company: true, jobTitle: true, headline: true, keywords: true, contacts: 2, icon: true, ...(d.show ?? {}) },
  } as CardTemplate;
}

// ── the 50 templates ───────────────────────────────────────────────────
export const CARD_TEMPLATES: readonly CardTemplate[] = [
  // ─ modern ─
  t({
    id: "swiss-grid", name: { ko: "스위스 그리드", en: "Swiss Grid" }, category: "modern", layout: "grid",
    palette: { bg: "#F7F7F4", fg: "#111111", accent: "#C8321B", muted: "#55554F" }, extraAccents: ["#1D4ED8", "#111111"],
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.035 },
    decoration: { rule: "thick", radius: 1.2 }, show: { contacts: 3 }, tags: ["design", "architecture", "consulting", "grid", "bold"],
  }),
  t({
    id: "startup-aurora", name: { ko: "스타트업 오로라", en: "Startup Aurora" }, category: "modern", layout: "classic",
    palette: { bg: "#3A2BB8", fg: "#FFFFFF", accent: "#FFD6EC", muted: "#E8E4FF", onAccent: "#2A1E86" }, extraAccents: ["#C9F5E4", "#FFE7B8"],
    background: { css: "radial-gradient(90% 120% at 100% 0%, rgba(255,120,190,.35), transparent 60%), linear-gradient(135deg, #3A2BB8 0%, #5B2AA6 55%, #7A2A86 100%)" },
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.03 },
    tags: ["startup", "tech", "marketing", "gradient", "bold"],
  }),
  t({
    id: "terminal-mono", name: { ko: "터미널 모노", en: "Terminal Mono" }, category: "modern", layout: "classic",
    palette: { bg: "#0D1117", fg: "#E6EDF3", accent: "#56D364", muted: "#9DA7B3", onAccent: "#0D1117" }, extraAccents: ["#79C0FF", "#F2CC60"],
    typography: { display: "mono", body: "mono", nameWeight: 600, nameTracking: -0.02, nameScale: 0.86 },
    decoration: { rule: "dotted", radius: 1.6 }, show: { contacts: 3 }, tags: ["tech", "developer", "startup", "dark", "mono"],
  }),
  t({
    id: "glass-frost", name: { ko: "글라스 프로스트", en: "Glass Frost" }, category: "modern", layout: "centered",
    palette: { bg: "#EEF0FF", fg: "#1B1B24", accent: "#5B4BD6", muted: "#4E4E62" }, extraAccents: ["#0F766E", "#A3335F"],
    background: { css: "radial-gradient(60% 80% at 15% 20%, rgba(255,184,214,.75), transparent 70%), radial-gradient(60% 90% at 90% 85%, rgba(150,214,255,.8), transparent 70%), linear-gradient(135deg, #EEF0FF, #E8F7F1)" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.03 },
    decoration: { panel: true, monogram: "circle" }, tags: ["tech", "startup", "design", "glass", "pastel"],
  }),
  t({
    id: "color-block-split", name: { ko: "컬러 블록", en: "Color Block" }, category: "modern", layout: "split",
    palette: { bg: "#FFFFFF", fg: "#14213D", accent: "#14213D", muted: "#4A5468", onAccent: "#FFFFFF" }, extraAccents: ["#7C2D12", "#065F46"],
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.03 },
    decoration: { monogram: "plain", radius: 1.8 }, tags: ["consulting", "marketing", "startup", "bold", "block"],
  }),
  t({
    id: "left-rail-iris", name: { ko: "아이리스 레일", en: "Iris Rail" }, category: "modern", layout: "rail",
    palette: { bg: "#FCFCFE", fg: "#1B1B24", accent: "#5B4BD6", muted: "#5F5F72", onAccent: "#FFFFFF" }, extraAccents: ["#A3335F", "#0F766E", "#1B1B24"],
    block: "linear-gradient(180deg, #6C5CE7, #5B4BD6 60%, #4B3BC0)",
    typography: { display: "serif", body: "sans", italic: true },
    tags: ["startup", "tech", "consulting", "linkos", "default"],
  }),
  t({
    id: "geo-tiles", name: { ko: "지오 타일", en: "Geo Tiles" }, category: "modern", layout: "band",
    palette: { bg: "#FFFFFF", fg: "#1F2430", accent: "#1F2430", muted: "#535A68", onAccent: "#FFFFFF" }, extraAccents: ["#1E3A8A", "#7C2D12"],
    block: "linear-gradient(135deg, #1F2430, #2E3546)",
    background: { css: "#FFFFFF", pattern: svg(40, 40, '<path d="M0 40 20 0l20 40z" fill="rgba(31,36,48,.045)"/><path d="M20 40 40 0v40z" fill="rgba(31,36,48,.03)"/>'), patternMode: "tile", patternSize: 7 },
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.02 },
    tags: ["architecture", "manufacturing", "tech", "pattern", "geometric"],
  }),
  // ─ classic ─
  t({
    id: "editorial-serif", name: { ko: "에디토리얼 세리프", en: "Editorial Serif" }, category: "classic", layout: "classic",
    palette: { bg: "#FBF8F2", fg: "#1E1B18", accent: "#8C2F1B", muted: "#5C554C" }, extraAccents: ["#1E3A5F", "#1E1B18"],
    typography: { display: "serif", body: "sans", nameScale: 1.12, italic: true },
    decoration: { rule: "hairline" }, tags: ["media", "consulting", "education", "editorial", "classic"],
  }),
  t({
    id: "linen-weave", name: { ko: "린넨 위브", en: "Linen Weave" }, category: "classic", layout: "classic",
    palette: { bg: "#F1ECE2", fg: "#2E2A24", accent: "#6B4E2E", muted: "#5B5348" }, extraAccents: ["#33503F", "#2E2A24"],
    background: { css: "repeating-linear-gradient(0deg, rgba(90,70,40,.035) 0 1px, transparent 1px 3px), repeating-linear-gradient(90deg, rgba(90,70,40,.03) 0 1px, transparent 1px 3px), #F1ECE2" },
    typography: { display: "serif", body: "sans", nameScale: 1.05 },
    decoration: { rule: "hairline", texture: "grain" }, tags: ["consulting", "food", "craft", "classic", "texture"],
  }),
  t({
    id: "crest-monogram", name: { ko: "크레스트 모노그램", en: "Crest Monogram" }, category: "classic", layout: "centered",
    palette: { bg: "#F8F5EE", fg: "#2A2140", accent: "#5A3F8C", muted: "#5A546A" }, extraAccents: ["#1E3A5F", "#7A1F2B"],
    typography: { display: "didone", body: "sans", nameCase: "upper", nameTracking: 0.08, nameScale: 0.72 },
    decoration: { monogram: "crest", rule: "double", frame: "inset" }, tags: ["law", "finance", "consulting", "luxury", "classic"],
  }),
  t({
    id: "academia", name: { ko: "아카데미아", en: "Academia" }, category: "classic", layout: "classic",
    palette: { bg: "#FDFBF6", fg: "#1F2A44", accent: "#7A1F2B", muted: "#535B6E" }, extraAccents: ["#1F2A44", "#2F5233"],
    typography: { display: "didone", body: "sans", nameScale: 0.95 },
    decoration: { monogram: "crest", rule: "hairline", frame: "inset" }, tags: ["education", "academic", "research", "law", "classic"],
  }),
  t({
    id: "letterpress-cotton", name: { ko: "레터프레스 코튼", en: "Letterpress Cotton" }, category: "classic", layout: "centered",
    palette: { bg: "#F4F1EA", fg: "#2B2A27", accent: "#3D3A35", muted: "#5C5952" }, extraAccents: ["#1E3A5F", "#7A2E2E"],
    typography: { display: "serif", body: "sans", nameScale: 1.1 },
    decoration: { emboss: true, texture: "grain", rule: "hairline" }, tags: ["craft", "consulting", "food", "luxury", "texture"],
  }),
  // ─ minimal ─
  t({
    id: "ma-minimal", name: { ko: "여백 미니멀", en: "Ma Minimal" }, category: "minimal", orientation: "portrait", layout: "stack",
    palette: { bg: "#FAFAF7", fg: "#222222", accent: "#B23A2E", muted: "#5E5E5A", onAccent: "#FFFFFF" }, extraAccents: ["#222222", "#2F5D50"],
    typography: { display: "kr", body: "kr", nameWeight: 500, nameTracking: 0.02, nameScale: 0.9 },
    decoration: { monogram: "square" }, show: { keywords: false, headline: false, contacts: 2 }, tags: ["design", "architecture", "minimal", "calm"],
  }),
  t({
    id: "nordic-calm", name: { ko: "노르딕 캄", en: "Nordic Calm" }, category: "minimal", layout: "classic",
    palette: { bg: "#EEF1EE", fg: "#23302A", accent: "#3F6152", muted: "#4F5C55" }, extraAccents: ["#4A5A78", "#23302A"],
    typography: { display: "sans", body: "sans", nameWeight: 500, nameTracking: -0.02 },
    tags: ["design", "energy", "beauty", "minimal", "calm"],
  }),
  t({
    id: "vertical-poise", name: { ko: "버티컬 포이즈", en: "Vertical Poise" }, category: "minimal", orientation: "portrait", layout: "stack",
    palette: { bg: "#FFFFFF", fg: "#1B1B24", accent: "#1B1B24", muted: "#5F5F72", onAccent: "#FFFFFF" }, extraAccents: ["#5B4BD6", "#A3335F"],
    typography: { display: "serif", body: "sans", nameScale: 1.05, italic: true },
    decoration: { rule: "hairline" }, show: { contacts: 3 }, tags: ["design", "media", "minimal", "portrait"],
  }),
  t({
    id: "center-quiet", name: { ko: "센터 콰이어트", en: "Center Quiet" }, category: "minimal", layout: "centered",
    palette: { bg: "#FCFCFE", fg: "#1B1B24", accent: "#5B4BD6", muted: "#5F5F72" }, extraAccents: ["#1B1B24", "#0F766E"],
    typography: { display: "serif", body: "sans", nameScale: 1.1 },
    decoration: { rule: "hairline" }, show: { keywords: false }, tags: ["consulting", "minimal", "default", "linkos"],
  }),
  t({
    id: "pure-contact", name: { ko: "퓨어 컨택트", en: "Pure Contact" }, category: "minimal", layout: "classic",
    palette: { bg: "#FFFFFF", fg: "#202124", accent: "#3C4043", muted: "#5F6368" }, extraAccents: ["#1A56DB", "#0F766E"],
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02, nameScale: 0.9 },
    show: { keywords: false, contacts: 3 }, tags: ["consulting", "marketing", "sales", "minimal", "clean"],
  }),
  // ─ luxury ─
  t({
    id: "noir-gold-foil", name: { ko: "누아르 골드 포일", en: "Noir Gold Foil" }, category: "luxury", layout: "centered",
    palette: { bg: "#0E0E10", fg: "#F3EBD3", accent: "#C9A45C", muted: "#BDB4A0", onAccent: "#0E0E10" }, extraAccents: ["#D8D2C4", "#D99A87"],
    background: { css: "radial-gradient(70% 90% at 50% 0%, rgba(201,164,92,.12), transparent 70%), #0E0E10" },
    typography: { display: "didone", body: "sans", nameCase: "upper", nameTracking: 0.12, nameScale: 0.7 },
    decoration: { foil: ["#9C7A3C", "#F1D99A", "#B8913F", "#FFF0C2", "#A6823A"], monogram: "diamond", rule: "hairline" },
    tags: ["luxury", "finance", "consulting", "jewelry", "dark", "foil"],
  }),
  t({
    id: "marble-veil", name: { ko: "마블 베일", en: "Marble Veil" }, category: "luxury", layout: "centered",
    palette: { bg: "#F5F4F1", fg: "#232323", accent: "#7A5E33", muted: "#585652" }, extraAccents: ["#232323", "#4B5563"],
    background: {
      css: "linear-gradient(160deg, #F7F6F3, #EFEDE8 60%, #F5F4F1)",
      pattern: svg(400, 250, '<g fill="none" stroke-linecap="round"><path d="M-10 60C60 40 90 120 160 110s110-70 180-40 60 70 90 60" stroke="rgba(120,112,100,.16)" stroke-width="1.4"/><path d="M-20 180c70-30 120 20 190-10s90-90 160-70 70 40 100 30" stroke="rgba(120,112,100,.12)" stroke-width="1"/><path d="M100 -10c10 60 60 80 50 140s30 90 20 130" stroke="rgba(150,140,125,.1)" stroke-width="2.2"/><path d="M300 0c-20 50 10 80-10 130" stroke="rgba(120,112,100,.1)" stroke-width=".8"/></g>'),
      patternMode: "cover",
    },
    typography: { display: "didone", body: "sans", nameScale: 0.95 },
    decoration: { foil: ["#7A5E33", "#94723F", "#6B5129", "#9C7A45"], rule: "hairline" },
    tags: ["luxury", "realestate", "architecture", "beauty", "marble"],
  }),
  t({
    id: "deco-fan", name: { ko: "아르데코 팬", en: "Deco Fan" }, category: "luxury", layout: "centered",
    palette: { bg: "#12201C", fg: "#EFE3C2", accent: "#C8A96A", muted: "#BFB59C", onAccent: "#12201C" }, extraAccents: ["#D9D3C3", "#E0A98F"],
    background: {
      css: "#12201C",
      pattern: svg(400, 250, '<g stroke="rgba(200,169,106,.22)" stroke-width="1" fill="none"><path d="M200 250 0 40M200 250 50 0M200 250 120 0M200 250 200 0M200 250 280 0M200 250 350 0M200 250 400 40"/><path d="M110 250a90 90 0 0 1 180 0M140 250a60 60 0 0 1 120 0"/></g>'),
      patternMode: "cover",
    },
    typography: { display: "didone", body: "sans", nameCase: "upper", nameTracking: 0.1, nameScale: 0.72 },
    decoration: { foil: ["#A88A4C", "#EED9A2", "#BE9C5A", "#F6E7BE"], frame: "double", corners: true },
    tags: ["luxury", "hospitality", "events", "artdeco", "dark", "foil"],
  }),
  t({
    id: "silver-steel", name: { ko: "실버 스틸", en: "Silver Steel" }, category: "luxury", layout: "rail",
    palette: { bg: "#1C1F24", fg: "#E9ECEF", accent: "#AEB6BF", muted: "#AAB2BC", onAccent: "#1C1F24" }, extraAccents: ["#C9A45C", "#9FC3E6"],
    block: "linear-gradient(180deg, #8C949E, #D6DCE2 45%, #8F98A2)",
    background: { css: "linear-gradient(135deg, #22262C, #1C1F24 60%, #181A1F)" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameCase: "upper", nameTracking: 0.06, nameScale: 0.78 },
    decoration: { foil: ["#9AA3AD", "#F1F4F7", "#AEB6BF", "#E2E7EC"] }, tags: ["finance", "tech", "manufacturing", "luxury", "dark", "metal"],
  }),
  t({
    id: "rose-gold", name: { ko: "로즈 골드", en: "Rose Gold" }, category: "luxury", layout: "centered",
    palette: { bg: "#FFF7F4", fg: "#3B2A2A", accent: "#9A4F3E", muted: "#6A5552" }, extraAccents: ["#3B2A2A", "#7A5E33"],
    typography: { display: "serif", body: "sans", nameScale: 1.1, italic: true },
    decoration: { foil: ["#9A4F3E", "#B76E5C", "#8A4636", "#A85E4C"], monogram: "circle", rule: "hairline" },
    tags: ["beauty", "luxury", "fashion", "wedding", "foil"],
  }),
  t({
    id: "holo-prism", name: { ko: "홀로 프리즘", en: "Holo Prism" }, category: "creative", layout: "classic",
    palette: { bg: "#17142A", fg: "#F4F1FF", accent: "#C9B6FF", muted: "#BDB6D8", onAccent: "#17142A" }, extraAccents: ["#9EE7FF", "#FFB3D9"],
    background: { css: "radial-gradient(80% 100% at 100% 0%, rgba(158,231,255,.16), transparent 60%), radial-gradient(70% 90% at 0% 100%, rgba(255,179,217,.16), transparent 60%), #17142A" },
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.03 },
    decoration: { foil: ["#9EE7FF", "#C9B6FF", "#FFB3D9", "#B8F5D0", "#9EE7FF"] },
    tags: ["creative", "tech", "media", "startup", "holographic", "dark"],
  }),
  // ─ creative ─
  t({
    id: "bauhaus-primary", name: { ko: "바우하우스 프라이머리", en: "Bauhaus Primary" }, category: "creative", layout: "classic",
    palette: { bg: "#F4EFE6", fg: "#1A1A1A", accent: "#1F4FBF", muted: "#4F4A42" }, extraAccents: ["#B42318", "#1A1A1A"],
    background: {
      css: "#F4EFE6",
      pattern: svg(400, 250, '<circle cx="330" cy="62" r="46" fill="#E5533D" fill-opacity=".9"/><path d="M262 30h46v46h-46z" fill="#1F4FBF" fill-opacity=".9"/><path d="M300 120l40-70 40 70z" fill="#F2C230" fill-opacity=".95"/>'),
      patternMode: "cover",
    },
    typography: { display: "sans", body: "sans", nameWeight: 800, nameTracking: -0.04 },
    decoration: { rule: "thick", radius: 1 }, show: { icon: false }, tags: ["design", "architecture", "education", "creative", "bold", "geometric"],
  }),
  t({
    id: "duotone-plum", name: { ko: "듀오톤 플럼", en: "Duotone Plum" }, category: "creative", layout: "split",
    palette: { bg: "#2D1B4E", fg: "#F7E9FF", accent: "#FF9FD0", muted: "#D9C6EA", onAccent: "#2D1B4E" }, extraAccents: ["#9FE6C8", "#FFD58A"],
    block: "linear-gradient(160deg, #FF9FD0, #F7B6E0)",
    typography: { display: "serif", body: "sans", nameScale: 1.05, italic: true },
    decoration: { monogram: "plain" }, tags: ["design", "media", "beauty", "creative", "duotone"],
  }),
  t({
    id: "midcentury-atomic", name: { ko: "미드센추리 아토믹", en: "Mid-century Atomic" }, category: "creative", layout: "classic",
    palette: { bg: "#F3E9D2", fg: "#2C2A26", accent: "#A8461F", muted: "#5A5345" }, extraAccents: ["#2F6B62", "#2C2A26"],
    background: {
      css: "#F3E9D2",
      pattern: svg(400, 250, '<g stroke="#D9653B" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"><path d="M340 40v36M322 58h36M327 45l26 26M353 45l-26 26"/></g><g stroke="#2F6B62" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round"><path d="M372 98v20M362 108h20"/></g><path d="M250 30c20-12 50-12 60 6" stroke="#2F6B62" stroke-opacity=".4" stroke-width="3" fill="none" stroke-linecap="round"/>'),
      patternMode: "cover",
    },
    typography: { display: "serif", body: "sans", nameScale: 1.08, italic: true },
    tags: ["design", "food", "media", "retro", "creative"],
  }),
  t({
    id: "brutalist-block", name: { ko: "브루탈리스트", en: "Brutalist Block" }, category: "creative", layout: "grid",
    palette: { bg: "#FFFFFF", fg: "#000000", accent: "#C2410C", muted: "#3F3F3F" }, extraAccents: ["#000000", "#1D4ED8"],
    typography: { display: "sans", body: "mono", nameWeight: 800, nameCase: "upper", nameTracking: -0.02, nameScale: 0.82 },
    decoration: { rule: "thick", frame: "inset", radius: 0 }, show: { contacts: 3 }, tags: ["design", "tech", "media", "bold", "brutalist"],
  }),
  t({
    id: "neon-night", name: { ko: "네온 나이트", en: "Neon Night" }, category: "creative", layout: "classic",
    palette: { bg: "#0B0B14", fg: "#F2F0FF", accent: "#7CF5D3", muted: "#B4B0CC", onAccent: "#0B0B14" }, extraAccents: ["#FF8AD8", "#9DB8FF"],
    background: { css: "radial-gradient(60% 80% at 100% 100%, rgba(124,245,211,.10), transparent 70%), #0B0B14" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02 },
    decoration: { glow: true, rule: "hairline" }, tags: ["media", "music", "tech", "events", "dark", "neon"],
  }),
  t({
    id: "watercolor-wash", name: { ko: "수채화 워시", en: "Watercolor Wash" }, category: "creative", layout: "centered",
    palette: { bg: "#FFFDFB", fg: "#2A2433", accent: "#7A3B69", muted: "#5B5466" }, extraAccents: ["#2F5D7A", "#3F6B4A"],
    background: { css: "radial-gradient(45% 60% at 18% 25%, rgba(255,190,210,.55), transparent 70%), radial-gradient(40% 55% at 82% 70%, rgba(170,210,255,.55), transparent 70%), radial-gradient(35% 45% at 60% 15%, rgba(200,240,215,.6), transparent 70%), #FFFDFB" },
    typography: { display: "serif", body: "sans", nameScale: 1.1, italic: true },
    tags: ["design", "beauty", "education", "wedding", "watercolor", "pastel"],
  }),
  t({
    id: "kraft-stamp", name: { ko: "크라프트 스탬프", en: "Kraft Stamp" }, category: "creative", layout: "monogram",
    palette: { bg: "#C9A77C", fg: "#2A1D10", accent: "#5A2E14", muted: "#3F2E1C", onAccent: "#F3E6D0" }, extraAccents: ["#1F3A2E", "#2A1D10"],
    background: { css: "radial-gradient(80% 80% at 30% 30%, rgba(255,240,210,.18), transparent 70%), #C9A77C", pattern: svg(60, 60, '<g fill="rgba(70,45,20,.12)"><circle cx="7" cy="9" r=".9"/><circle cx="31" cy="21" r=".7"/><circle cx="48" cy="44" r="1"/><circle cx="16" cy="50" r=".6"/><circle cx="52" cy="8" r=".6"/></g>'), patternMode: "tile", patternSize: 10 },
    typography: { display: "mono", body: "mono", nameWeight: 600, nameCase: "upper", nameTracking: 0.04, nameScale: 0.8 },
    decoration: { texture: "grain" }, tags: ["food", "craft", "coffee", "eco", "creative"],
  }),
  t({
    id: "culinary-chalk", name: { ko: "셰프 칠판", en: "Culinary Chalk" }, category: "industry", layout: "centered",
    palette: { bg: "#22262A", fg: "#F1EEE6", accent: "#E8B04B", muted: "#C2BEB4", onAccent: "#22262A" }, extraAccents: ["#9FD3B0", "#F2A38C"],
    background: { css: "radial-gradient(90% 90% at 50% 50%, rgba(255,255,255,.04), transparent 70%), #22262A" },
    typography: { display: "serif", body: "sans", nameScale: 1.1, italic: true },
    decoration: { texture: "grain", rule: "dotted" }, tags: ["food", "restaurant", "chef", "cafe", "dark"],
  }),
  // ─ industry ─
  t({
    id: "blueprint", name: { ko: "블루프린트", en: "Blueprint" }, category: "industry", layout: "grid",
    palette: { bg: "#0F3B66", fg: "#EAF3FF", accent: "#8CC8FF", muted: "#BFD8F2", onAccent: "#0F3B66" }, extraAccents: ["#FFFFFF", "#FFD27A"],
    background: { css: "#0F3B66", pattern: svg(20, 20, '<path d="M20 0H0v20" fill="none" stroke="rgba(180,215,255,.16)" stroke-width="1"/>'), patternMode: "tile", patternSize: 4 },
    typography: { display: "mono", body: "mono", nameWeight: 600, nameScale: 0.82 },
    decoration: { corners: true, rule: "hairline", radius: 1 }, show: { contacts: 3 }, tags: ["architecture", "manufacturing", "engineering", "tech", "construction"],
  }),
  t({
    id: "architect-line", name: { ko: "아키텍트 라인", en: "Architect Line" }, category: "industry", layout: "grid",
    palette: { bg: "#F2F2EF", fg: "#1D1D1B", accent: "#3D3D3A", muted: "#51514D" }, extraAccents: ["#9A3412", "#1E40AF"],
    background: { css: "#F2F2EF", pattern: svg(24, 24, '<path d="M24 0H0v24" fill="none" stroke="rgba(30,30,28,.06)" stroke-width=".8"/>'), patternMode: "tile", patternSize: 3.2 },
    typography: { display: "sans", body: "sans", nameWeight: 500, nameTracking: -0.02 },
    decoration: { corners: true, rule: "hairline", radius: 0.6 }, show: { contacts: 3 }, tags: ["architecture", "realestate", "construction", "design", "interior"],
  }),
  t({
    id: "counsel-classic", name: { ko: "카운슬 클래식", en: "Counsel Classic" }, category: "industry", layout: "centered",
    palette: { bg: "#FFFFFF", fg: "#1C2333", accent: "#1C3A6B", muted: "#4B5366" }, extraAccents: ["#5B1F2A", "#1C2333"],
    typography: { display: "kr-serif", body: "sans", nameWeight: 600, nameTracking: 0.04, nameScale: 0.85 },
    decoration: { rule: "double", frame: "inset" }, show: { keywords: false, contacts: 3 }, tags: ["law", "finance", "consulting", "tax", "classic"],
  }),
  t({
    id: "ledger-finance", name: { ko: "레저 파이낸스", en: "Ledger Finance" }, category: "industry", layout: "band",
    palette: { bg: "#F8FAF9", fg: "#10231B", accent: "#0F5C3F", muted: "#4A5A52", onAccent: "#FFFFFF" }, extraAccents: ["#1C3A6B", "#10231B"],
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02 },
    decoration: { rule: "hairline" }, show: { contacts: 3 }, tags: ["finance", "bank", "accounting", "insurance", "investment"],
  }),
  t({
    id: "clinic-clean", name: { ko: "클리닉 클린", en: "Clinic Clean" }, category: "industry", layout: "rail",
    palette: { bg: "#FFFFFF", fg: "#0F2A3A", accent: "#0B6E77", muted: "#4A6070", onAccent: "#FFFFFF" }, extraAccents: ["#1D4ED8", "#0F2A3A"],
    block: "linear-gradient(180deg, #0B6E77, #0B7A80)",
    typography: { display: "kr", body: "kr", nameWeight: 600, nameTracking: -0.02 },
    show: { contacts: 3 }, tags: ["medical", "health", "pharma", "dental", "bio", "clean"],
  }),
  t({
    id: "realty-keystone", name: { ko: "리얼티 키스톤", en: "Realty Keystone" }, category: "industry", layout: "rail",
    palette: { bg: "#F7F5F0", fg: "#222831", accent: "#7F5422", muted: "#555A62", onAccent: "#FFFFFF" }, extraAccents: ["#1E3A5F", "#222831"],
    typography: { display: "didone", body: "sans", nameScale: 0.95 },
    decoration: { rule: "hairline" }, show: { contacts: 3 }, tags: ["realestate", "architecture", "interior", "property", "luxury"],
  }),
  t({
    id: "eco-leaf", name: { ko: "에코 리프", en: "Eco Leaf" }, category: "industry", layout: "band",
    palette: { bg: "#F3F8F1", fg: "#1D3324", accent: "#2F6A2C", muted: "#4A5E4F", onAccent: "#FFFFFF" }, extraAccents: ["#1E5A6B", "#1D3324"],
    background: { css: "#F3F8F1", pattern: svg(400, 250, '<path d="M330 230c0-70 30-120 70-140-5 70-30 120-70 140z" fill="rgba(47,106,44,.08)"/><path d="M360 250c-10-50 0-80 30-100 5 50-10 80-30 100z" fill="rgba(47,106,44,.06)"/>'), patternMode: "cover" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02 },
    tags: ["energy", "climate", "eco", "agriculture", "esg"],
  }),
  t({
    id: "media-reel", name: { ko: "미디어 릴", en: "Media Reel" }, category: "industry", layout: "split",
    palette: { bg: "#111111", fg: "#FAFAFA", accent: "#FF6B6B", muted: "#BDBDBD", onAccent: "#111111" }, extraAccents: ["#FFD166", "#7FD1FF"],
    typography: { display: "sans", body: "sans", nameWeight: 700, nameTracking: -0.03 },
    decoration: { monogram: "plain" }, tags: ["media", "film", "broadcast", "music", "entertainment", "dark"],
  }),
  // ─ korean ─
  t({
    id: "dancheong-band", name: { ko: "단청 띠", en: "Dancheong Band" }, category: "korean", layout: "classic",
    palette: { bg: "#F7F3EA", fg: "#1E2B2A", accent: "#1F5F50", muted: "#4E5A57" }, extraAccents: ["#8E2F22", "#2B4C8C"],
    stripe: "linear-gradient(90deg, #2E7D6B 0 18%, #B5432F 18% 30%, #2B4C8C 30% 46%, #E3B23C 46% 54%, #F7F3EA 54% 58%, #2E7D6B 58% 76%, #B5432F 76% 86%, #2B4C8C 86% 100%)",
    typography: { display: "kr-serif", body: "kr", nameWeight: 600, nameScale: 0.95 },
    decoration: { rule: "hairline" }, tags: ["korean", "culture", "tradition", "craft", "tourism"],
  }),
  t({
    id: "hanji-fiber", name: { ko: "한지 결", en: "Hanji Fiber" }, category: "korean", orientation: "portrait", layout: "stack",
    palette: { bg: "#F4EEDF", fg: "#2B2620", accent: "#8E3B2E", muted: "#5A5246", onAccent: "#F4EEDF" }, extraAccents: ["#2B2620", "#2F5233"],
    background: { css: "#F4EEDF", pattern: svg(120, 120, '<g fill="none" stroke="rgba(120,100,70,.13)" stroke-width=".7" stroke-linecap="round"><path d="M5 20c20-6 30 4 50-2M60 70c15-8 30 2 50-4M10 95c12 4 20-2 34 2M70 15c8 10 20 8 30 14M30 55c6-10 16-12 26-8"/></g>'), patternMode: "tile", patternSize: 28 },
    typography: { display: "kr-serif", body: "kr", nameWeight: 600, nameTracking: 0.06, nameScale: 0.9 },
    decoration: { monogram: "square", texture: "grain" }, show: { keywords: false }, tags: ["korean", "craft", "culture", "tradition", "paper"],
  }),
  t({
    id: "moon-jar", name: { ko: "달항아리", en: "Moon Jar" }, category: "korean", layout: "monogram",
    palette: { bg: "#F2EFE8", fg: "#2D2A26", accent: "#5E5546", muted: "#595449" }, extraAccents: ["#2D2A26", "#3E5A6B"],
    background: { css: "radial-gradient(34% 54% at 78% 50%, rgba(255,255,255,.9), rgba(255,255,255,.5) 60%, transparent 72%), #F2EFE8" },
    typography: { display: "kr-serif", body: "kr", nameWeight: 500, nameTracking: 0.04 },
    decoration: { emboss: true }, tags: ["korean", "craft", "luxury", "culture", "calm"],
  }),
  t({
    id: "ink-brush", name: { ko: "수묵 붓", en: "Ink Brush" }, category: "korean", orientation: "portrait", layout: "stack",
    palette: { bg: "#FBFAF6", fg: "#151515", accent: "#9E2A2B", muted: "#55524B", onAccent: "#FFFFFF" }, extraAccents: ["#151515", "#2F5233"],
    background: { css: "#FBFAF6", pattern: svg(250, 400, '<path d="M20 360c40-12 90-10 130-26s70-10 90-22" stroke="rgba(20,20,20,.10)" stroke-width="14" stroke-linecap="round" fill="none"/><path d="M40 382c50-8 110-6 170-20" stroke="rgba(20,20,20,.06)" stroke-width="6" stroke-linecap="round" fill="none"/>'), patternMode: "cover" },
    typography: { display: "kr-serif", body: "kr", nameWeight: 700, nameTracking: 0.04 },
    decoration: { monogram: "square" }, tags: ["korean", "culture", "education", "art", "calligraphy"],
  }),
  t({
    id: "bojagi-patch", name: { ko: "보자기 패치", en: "Bojagi Patch" }, category: "korean", layout: "classic",
    palette: { bg: "#FFFFFF", fg: "#22252B", accent: "#8A2D4A", muted: "#555A63" }, extraAccents: ["#1F5F50", "#2B4C8C"],
    background: {
      css: "#FFFFFF",
      pattern: svg(400, 250, '<g stroke="rgba(255,255,255,.9)" stroke-width="2"><path d="M300 0h100v70H300z" fill="#F6C7D4"/><path d="M300 70h55v60h-55z" fill="#CFE8DD"/><path d="M355 70h45v95h-45z" fill="#F7E3A6"/><path d="M300 130h55v120h-55z" fill="#C9D8F2"/><path d="M355 165h45v85h-45z" fill="#E9D5F5"/><path d="M262 0h38v52h-38z" fill="#DDEFE6"/></g>'),
      patternMode: "cover",
    },
    typography: { display: "kr", body: "kr", nameWeight: 700, nameTracking: -0.02 },
    show: { icon: false }, tags: ["korean", "craft", "fashion", "design", "pattern"],
  }),
  // ─ pastel (LINKOS Porcelain & Pastel family) ─
  t({
    id: "pastel-lavender", name: { ko: "파스텔 라벤더", en: "Pastel Lavender" }, category: "pastel", layout: "classic",
    palette: { bg: "#ECE8FF", fg: "#1B1B24", accent: "#5B4BD6", muted: "#4C4A63" }, extraAccents: ["#A3335F", "#1B1B24"],
    background: { css: "linear-gradient(140deg, #F1EDFF, #ECE8FF 55%, #E6EEFF)" },
    typography: { display: "serif", body: "sans", italic: true }, decoration: { rule: "hairline" }, tags: ["startup", "design", "linkos", "pastel", "default"],
  }),
  t({
    id: "pastel-mint", name: { ko: "파스텔 민트", en: "Pastel Mint" }, category: "pastel", layout: "rail",
    palette: { bg: "#DCF5EA", fg: "#13322A", accent: "#1A6B50", muted: "#3E5B52", onAccent: "#FFFFFF" }, extraAccents: ["#13322A", "#2C5FB3"],
    background: { css: "linear-gradient(150deg, #E4F8EF, #DCF5EA)" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02 }, tags: ["medical", "energy", "education", "pastel"],
  }),
  t({
    id: "pastel-peach", name: { ko: "파스텔 피치", en: "Pastel Peach" }, category: "pastel", layout: "centered",
    palette: { bg: "#FFE8DD", fg: "#3A1F14", accent: "#A13F22", muted: "#64463A" }, extraAccents: ["#3A1F14", "#7A3B69"],
    background: { css: "linear-gradient(150deg, #FFEDE4, #FFE8DD 60%, #FDE6EF)" },
    typography: { display: "serif", body: "sans", nameScale: 1.1, italic: true }, decoration: { monogram: "circle" }, tags: ["food", "beauty", "wedding", "pastel"],
  }),
  t({
    id: "pastel-sky", name: { ko: "파스텔 스카이", en: "Pastel Sky" }, category: "pastel", layout: "band",
    palette: { bg: "#DCEBFF", fg: "#12243F", accent: "#2A5AAA", muted: "#3D5070", onAccent: "#FFFFFF" }, extraAccents: ["#12243F", "#5B4BD6"],
    background: { css: "linear-gradient(160deg, #E4F0FF, #DCEBFF)" },
    typography: { display: "sans", body: "sans", nameWeight: 600, nameTracking: -0.02 }, tags: ["tech", "travel", "education", "pastel"],
  }),
  t({
    id: "pastel-butter", name: { ko: "파스텔 버터", en: "Pastel Butter" }, category: "pastel", layout: "monogram",
    palette: { bg: "#FFF4D2", fg: "#3A2E0E", accent: "#7A5C0C", muted: "#5E5233" }, extraAccents: ["#3A2E0E", "#A13F22"],
    background: { css: "linear-gradient(150deg, #FFF7DE, #FFF4D2)" },
    typography: { display: "serif", body: "sans", italic: true }, tags: ["food", "education", "kids", "pastel"],
  }),
  t({
    id: "pastel-rose", name: { ko: "파스텔 로즈", en: "Pastel Rose" }, category: "pastel", layout: "split",
    palette: { bg: "#FDE6EF", fg: "#3B1426", accent: "#A3335F", muted: "#5F3A4B", onAccent: "#FFFFFF" }, extraAccents: ["#5B4BD6", "#3B1426"],
    background: { css: "linear-gradient(150deg, #FEEDF3, #FDE6EF)" },
    typography: { display: "serif", body: "sans", nameScale: 1.05, italic: true }, decoration: { monogram: "plain" }, tags: ["beauty", "fashion", "wedding", "design", "pastel"],
  }),
];

const BY_ID = new Map(CARD_TEMPLATES.map((x) => [x.id, x]));
export const TEMPLATE_IDS: readonly string[] = CARD_TEMPLATES.map((x) => x.id);

export function getCardTemplate(id: string | null | undefined): CardTemplate | undefined {
  return id ? BY_ID.get(id) : undefined;
}
export function isCardTemplateId(id: string): boolean {
  return BY_ID.has(id);
}

export const AA_BODY = 4.5;
export const AA_LARGE = 3;

export interface ContrastIssue {
  templateId: string;
  pair: string;
  ratio: number;
  min: number;
}

/** Every text/background pairing a template can produce, checked against WCAG AA. */
export function templateContrastIssues(tpl: CardTemplate): ContrastIssue[] {
  const out: ContrastIssue[] = [];
  const check = (pair: string, a: string, b: string, min: number) => {
    const r = contrastRatio(a, b);
    if (r < min) out.push({ templateId: tpl.id, pair, ratio: +r.toFixed(2), min });
  };
  const surfaces = [tpl.palette.bg, ...opaqueStops(tpl.background.css)];
  for (const s of surfaces) {
    check(`fg/${s}`, tpl.palette.fg, s, AA_BODY);
    check(`muted/${s}`, tpl.palette.muted, s, AA_BODY);
  }
  for (const a of tpl.accentOptions) {
    check(`accent ${a}/bg`, a, tpl.palette.bg, AA_BODY);
    // blocks are painted with the accent (or, for the default accent, the template's block recipe)
    check(`onAccent/accent ${a}`, tpl.palette.onAccent, a, AA_BODY);
  }
  if (tpl.block) for (const s of opaqueStops(tpl.block)) check(`onAccent/block ${s}`, tpl.palette.onAccent, s, AA_BODY);
  for (const f of tpl.decoration.foil ?? []) check(`foil ${f}/bg`, f, tpl.palette.bg, AA_LARGE);
  return out;
}

// ── structural validation ──────────────────────────────────────────────
const HEX = /^#[0-9A-Fa-f]{6}$/;
const UNSAFE = /<script|javascript:|href|url\(|@import|on[a-z]+\s*=|<foreignObject|<image/i;

export function validateCardTemplate(tpl: CardTemplate): string[] {
  const e: string[] = [];
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(tpl.id)) e.push("id");
  if (!tpl.name.ko.trim() || !tpl.name.en.trim()) e.push("name");
  if (!TEMPLATE_CATEGORIES.includes(tpl.category)) e.push("category");
  if (!TEMPLATE_LAYOUTS.includes(tpl.layout)) e.push("layout");
  if (tpl.orientation !== "landscape" && tpl.orientation !== "portrait") e.push("orientation");
  if (tpl.orientation === "portrait" && tpl.layout !== "stack") e.push("portrait templates use the stack layout");
  for (const [k, v] of Object.entries(tpl.palette)) if (!HEX.test(v)) e.push(`palette.${k}`);
  if (!tpl.accentOptions.length || tpl.accentOptions[0] !== tpl.palette.accent) e.push("accentOptions[0] must equal palette.accent");
  for (const a of tpl.accentOptions) if (!HEX.test(a)) e.push(`accentOption ${a}`);
  if (new Set(tpl.accentOptions.map((a) => a.toUpperCase())).size !== tpl.accentOptions.length) e.push("duplicate accent option");
  for (const css of [tpl.background.css, tpl.block ?? "", tpl.stripe ?? ""]) if (UNSAFE.test(css)) e.push("unsafe css");
  if (tpl.background.pattern !== undefined) {
    if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/.test(tpl.background.pattern) || UNSAFE.test(tpl.background.pattern)) e.push("unsafe pattern");
    if (tpl.background.pattern.length > 4000) e.push("pattern too large");
    if (tpl.background.patternMode === "tile" && !(tpl.background.patternSize && tpl.background.patternSize > 0)) e.push("patternSize");
  }
  if (!FONT_ROLES.includes(tpl.typography.display) || !FONT_ROLES.includes(tpl.typography.body)) e.push("font role");
  if (tpl.typography.nameScale < 0.6 || tpl.typography.nameScale > 1.3) e.push("nameScale");
  if (Math.abs(tpl.typography.nameTracking) > 0.2) e.push("nameTracking");
  if (tpl.decoration.foil && (tpl.decoration.foil.length < 2 || tpl.decoration.foil.some((c) => !HEX.test(c)))) e.push("foil");
  if (tpl.decoration.radius < 0 || tpl.decoration.radius > 6) e.push("radius");
  if (![0, 1, 2, 3].includes(tpl.show.contacts)) e.push("show.contacts");
  if (!tpl.tags.length) e.push("tags");
  return e;
}

// ── search & suggestions ───────────────────────────────────────────────
/** Topic keys → ko/en synonyms. Latin synonyms match whole words or ≥4-char prefixes; Hangul synonyms match substrings. */
export const TOPIC_SYNONYMS: Record<string, string[]> = {
  law: ["law", "legal", "lawyer", "attorney", "counsel", "patent", "법", "법률", "변호사", "법무", "특허", "변리사", "노무사", "법률사무소"],
  finance: ["finance", "financial", "bank", "banking", "invest", "investor", "investment", "vc", "capital", "fund", "accounting", "accountant", "tax", "insurance", "fintech", "금융", "은행", "투자", "증권", "회계", "세무", "보험", "자산", "펀드", "벤처캐피탈", "핀테크", "재무"],
  medical: ["medical", "medicine", "health", "healthcare", "clinic", "hospital", "doctor", "pharma", "bio", "biotech", "dental", "nurse", "의료", "병원", "의사", "헬스케어", "제약", "바이오", "치과", "한의", "약사", "간호", "의원"],
  tech: ["tech", "technology", "software", "developer", "engineer", "engineering", "ai", "data", "cloud", "saas", "devops", "platform", "개발", "소프트웨어", "엔지니어", "인공지능", "데이터", "클라우드", "플랫폼", "개발자", "테크"],
  startup: ["startup", "founder", "cofounder", "ceo", "seed", "series", "venture", "스타트업", "창업", "대표", "시드", "시리즈", "창업자"],
  design: ["design", "designer", "brand", "branding", "ux", "ui", "art", "artist", "illustration", "illustrator", "photo", "photographer", "디자인", "디자이너", "브랜드", "브랜딩", "예술", "작가", "사진", "일러스트"],
  creative: ["creative", "studio", "agency", "크리에이티브", "스튜디오", "에이전시"],
  food: ["food", "restaurant", "chef", "cafe", "coffee", "bakery", "wine", "catering", "식당", "요리", "셰프", "카페", "커피", "베이커리", "외식", "와인", "음식", "레스토랑"],
  education: ["education", "teacher", "professor", "university", "school", "academy", "lecturer", "교육", "선생", "교수", "대학", "학교", "학원", "강사", "에듀"],
  research: ["research", "researcher", "lab", "science", "scientist", "phd", "연구", "연구원", "연구소", "과학", "박사"],
  academic: ["academic", "scholar", "학술", "학자"],
  realestate: ["realestate", "realty", "property", "broker", "부동산", "중개", "분양", "임대", "공인중개사"],
  architecture: ["architect", "architecture", "interior", "construction", "building", "건축", "인테리어", "건설", "시공", "설계", "건축가"],
  construction: ["construction", "contractor", "건설", "시공", "토목"],
  engineering: ["engineering", "mechanical", "civil", "공학", "기계", "엔지니어링"],
  manufacturing: ["manufacturing", "manufacturer", "factory", "industrial", "hardware", "semiconductor", "제조", "공장", "산업", "반도체", "부품", "생산"],
  energy: ["energy", "climate", "solar", "green", "esg", "sustainability", "sustainable", "environment", "에너지", "기후", "태양광", "친환경", "환경", "탄소", "신재생"],
  eco: ["eco", "organic", "zero", "비건", "유기농", "제로웨이스트"],
  agriculture: ["agriculture", "farm", "farming", "agritech", "농업", "농장", "스마트팜"],
  media: ["media", "film", "video", "broadcast", "entertainment", "content", "journalist", "pr", "미디어", "영상", "방송", "엔터", "콘텐츠", "홍보", "기자", "영화"],
  music: ["music", "musician", "producer", "음악", "뮤지션", "프로듀서", "작곡"],
  luxury: ["luxury", "premium", "jewelry", "private", "boutique", "럭셔리", "프리미엄", "주얼리", "명품", "부티크"],
  fashion: ["fashion", "apparel", "stylist", "패션", "의류", "스타일리스트"],
  hospitality: ["hospitality", "hotel", "resort", "호텔", "리조트", "숙박"],
  consulting: ["consulting", "consultant", "advisor", "advisory", "strategy", "partner", "컨설팅", "컨설턴트", "자문", "전략", "파트너"],
  marketing: ["marketing", "marketer", "growth", "ads", "advertising", "마케팅", "마케터", "광고", "그로스"],
  sales: ["sales", "account", "bizdev", "영업", "세일즈", "사업개발"],
  korean: ["korea", "korean", "hanbok", "tradition", "traditional", "culture", "heritage", "한국", "전통", "문화", "한옥", "한식", "국악", "한복", "문화재"],
  craft: ["craft", "craftsman", "handmade", "ceramic", "pottery", "공예", "수공예", "도예", "장인", "핸드메이드"],
  beauty: ["beauty", "cosmetic", "cosmetics", "salon", "spa", "wellness", "yoga", "skincare", "뷰티", "화장품", "미용", "웰니스", "요가", "스파", "피부"],
  wedding: ["wedding", "bridal", "planner", "웨딩", "결혼", "플래너"],
  events: ["event", "events", "festival", "conference", "이벤트", "행사", "축제", "컨퍼런스"],
  travel: ["travel", "tourism", "tour", "airline", "여행", "관광", "투어", "항공"],
  tourism: ["tourism", "tourist", "관광", "관광객"],
  kids: ["kids", "children", "baby", "키즈", "아동", "유아", "어린이"],
};

const HANGUL = /[가-힣]/;

function tokenize(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^a-z0-9가-힣&]+/)
    .filter(Boolean);
}

/** Topic keys mentioned in free text (deterministic). */
export function topicsIn(text: string): Set<string> {
  const toks = tokenize(text);
  const out = new Set<string>();
  for (const [topic, syns] of Object.entries(TOPIC_SYNONYMS)) {
    for (const s of syns) {
      const hit = HANGUL.test(s) ? toks.some((tk) => tk.includes(s)) : toks.some((tk) => tk === s || (s.length >= 4 && tk.startsWith(s)));
      if (hit) {
        out.add(topic);
        break;
      }
    }
  }
  return out;
}

export interface SuggestProfile {
  industries?: string[] | null;
  keywords?: string[] | null;
  jobTitle?: string | null;
  headline?: string | null;
  company?: string | null;
  bioShort?: string | null;
}
export interface TemplateSuggestion {
  template: CardTemplate;
  score: number;
  matched: string[];
}

/** Neutral, on-brand fallbacks (and tie-break order) when nothing in the profile matches. */
export const DEFAULT_SUGGESTIONS = ["left-rail-iris", "center-quiet", "pastel-lavender", "swiss-grid", "editorial-serif", "glass-frost"] as const;

/**
 * Deterministic industry/keyword → ranked templates (X-008). Weights: industries 3, keywords/job title 2,
 * headline/company/bio 1. Ties break on DEFAULT_SUGGESTIONS order, then catalog order. Pads with defaults.
 */
export function suggestTemplates(profile: SuggestProfile, limit = 6): TemplateSuggestion[] {
  const weighted: [Set<string>, number][] = [
    [topicsIn((profile.industries ?? []).join(" ")), 3],
    [topicsIn([...(profile.keywords ?? []), profile.jobTitle ?? ""].join(" ")), 2],
    [topicsIn([profile.headline ?? "", profile.company ?? "", profile.bioShort ?? ""].join(" ")), 1],
  ];
  const rank = (id: string) => {
    const d = (DEFAULT_SUGGESTIONS as readonly string[]).indexOf(id);
    return d >= 0 ? d : DEFAULT_SUGGESTIONS.length + TEMPLATE_IDS.indexOf(id);
  };
  const scored = CARD_TEMPLATES.map((template) => {
    let score = 0;
    const matched = new Set<string>();
    for (const [topics, w] of weighted)
      for (const tag of template.tags)
        if (topics.has(tag)) {
          score += w;
          matched.add(tag);
        }
    return { template, score, matched: [...matched].sort() };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || rank(a.template.id) - rank(b.template.id));
  const out = scored.slice(0, limit);
  for (const id of DEFAULT_SUGGESTIONS) {
    if (out.length >= limit) break;
    if (!out.some((s) => s.template.id === id)) out.push({ template: BY_ID.get(id)!, score: 0, matched: [] });
  }
  return out;
}

/** Gallery search: ko/en name, category label, tags (incl. tag synonyms). */
export function searchTemplates(query: string, category?: TemplateCategory | null): CardTemplate[] {
  const q = query.trim().toLowerCase();
  const topics = q ? topicsIn(q) : new Set<string>();
  return CARD_TEMPLATES.filter((tpl) => {
    if (category && tpl.category !== category) return false;
    if (!q) return true;
    const label = TEMPLATE_CATEGORY_LABEL[tpl.category];
    return (
      tpl.name.ko.toLowerCase().includes(q) ||
      tpl.name.en.toLowerCase().includes(q) ||
      tpl.id.includes(q) ||
      label.ko.includes(q) ||
      label.en.toLowerCase().includes(q) ||
      tpl.tags.some((tag) => tag.includes(q) || topics.has(tag))
    );
  });
}
