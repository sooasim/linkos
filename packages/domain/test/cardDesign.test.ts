// F-021 / F-022 Living Card design studio · F-036 action CTA icons — domain unit tests
import { describe, expect, it } from "vitest";
import { resolveCardDesign, resolveGlyph, validateCardDesign } from "../src/cardDesign";
import {
  CARD_TEMPLATES,
  DEFAULT_SUGGESTIONS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LAYOUTS,
  contrastRatio,
  getCardTemplate,
  initialsFor,
  opaqueStops,
  searchTemplates,
  suggestTemplates,
  templateContrastIssues,
  topicsIn,
  validateCardTemplate,
} from "../src/cardTemplates";
import { EMOJI_BANK, EMOJI_CATEGORIES, graphemeCount, isBankEmoji, searchEmoji } from "../src/emojiBank";
import { ICON_BANK, ICON_CATEGORIES, getBankIcon, searchIcons } from "../src/iconBank";

describe("F-021 card templates — catalog", () => {
  it("has exactly 50 templates with unique ids and names", () => {
    expect(CARD_TEMPLATES).toHaveLength(50);
    expect(new Set(CARD_TEMPLATES.map((t) => t.id)).size).toBe(50);
    expect(new Set(CARD_TEMPLATES.map((t) => t.name.en)).size).toBe(50);
    expect(new Set(CARD_TEMPLATES.map((t) => t.name.ko)).size).toBe(50);
  });

  it.each(CARD_TEMPLATES.map((t) => [t.id, t] as const))("F-021 template %s is structurally valid", (_id, tpl) => {
    expect(validateCardTemplate(tpl)).toEqual([]);
  });

  it.each(CARD_TEMPLATES.map((t) => [t.id, t] as const))("F-021 template %s passes WCAG AA contrast (fg/muted/accent/onAccent ≥ 4.5, foil ≥ 3)", (_id, tpl) => {
    expect(templateContrastIssues(tpl)).toEqual([]);
    // explicit check of the headline requirement: body text fg/bg ≥ 4.5 on the dominant paper color
    expect(contrastRatio(tpl.palette.fg, tpl.palette.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("covers every category and layout archetype, both orientations", () => {
    for (const c of TEMPLATE_CATEGORIES) expect(CARD_TEMPLATES.some((t) => t.category === c)).toBe(true);
    for (const l of TEMPLATE_LAYOUTS) expect(CARD_TEMPLATES.some((t) => t.layout === l)).toBe(true);
    expect(CARD_TEMPLATES.some((t) => t.orientation === "portrait")).toBe(true);
    expect(CARD_TEMPLATES.filter((t) => t.orientation === "landscape").length).toBeGreaterThan(40);
  });

  it("uses no external images or network resources in backgrounds", () => {
    for (const t of CARD_TEMPLATES) {
      expect(t.background.css).not.toMatch(/url\(/i);
      expect(t.background.pattern ?? "").not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    }
  });

  it("validator rejects unsafe or malformed templates", () => {
    const base = getCardTemplate("swiss-grid")!;
    expect(validateCardTemplate({ ...base, id: "Bad Id" })).toContain("id");
    expect(validateCardTemplate({ ...base, background: { css: "url(https://evil.test/x.png)" } })).toContain("unsafe css");
    expect(validateCardTemplate({ ...base, background: { css: "#fff", pattern: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' } })).toContain("unsafe pattern");
    expect(validateCardTemplate({ ...base, accentOptions: ["#000000"] })).toContain("accentOptions[0] must equal palette.accent");
    expect(templateContrastIssues({ ...base, palette: { ...base.palette, fg: "#EEEEEE" } }).length).toBeGreaterThan(0);
  });

  it("contrast math matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
    expect(opaqueStops("linear-gradient(#abc, #A0B0C0 50%, rgba(0,0,0,.2))")).toEqual(["#ABC", "#A0B0C0"]);
  });

  it("initials: Hangul family syllable, latin first+last", () => {
    expect(initialsFor("홍길동")).toBe("홍");
    expect(initialsFor("Mina Seo")).toBe("MS");
    expect(initialsFor("jun")).toBe("J");
    expect(initialsFor("  ")).toBe("");
  });
});

describe("F-021 suggestTemplates — deterministic industry/keyword ranking", () => {
  it("maps Korean and English profile text to topics", () => {
    expect([...topicsIn("법률사무소 파트너 변호사")]).toEqual(expect.arrayContaining(["law", "consulting"]));
    expect(topicsIn("Medical AI startup founder").has("medical")).toBe(true);
    expect(topicsIn("Medical AI startup founder").has("startup")).toBe(true);
    expect(topicsIn("with it").has("tech")).toBe(false); // no short-token false positives
  });

  it("ranks law templates first for a lawyer", () => {
    const s = suggestTemplates({ industries: ["법률"], jobTitle: "변호사" });
    expect(s[0]!.template.tags).toContain("law");
    expect(s.slice(0, 3).every((x) => x.template.tags.includes("law"))).toBe(true);
  });

  it("ranks medical templates for healthcare", () => {
    const s = suggestTemplates({ industries: ["헬스케어"], keywords: ["의료AI"] });
    expect(s[0]!.template.id).toBe("clinic-clean");
  });

  it("korean culture → korean category", () => {
    const s = suggestTemplates({ industries: ["전통 공예"], headline: "한국 문화 콘텐츠" });
    expect(s[0]!.template.category).toBe("korean");
  });

  it("is deterministic and pads with on-brand defaults", () => {
    const p = { industries: ["Finance"], keywords: ["VC", "Seed"], jobTitle: "Partner" };
    expect(suggestTemplates(p).map((x) => x.template.id)).toEqual(suggestTemplates(p).map((x) => x.template.id));
    const empty = suggestTemplates({});
    expect(empty.map((x) => x.template.id)).toEqual([...DEFAULT_SUGGESTIONS]);
    expect(empty.every((x) => x.score === 0)).toBe(true);
    expect(suggestTemplates({ industries: ["finance"] }, 3)).toHaveLength(3);
  });

  it("industries weigh more than headline mentions", () => {
    const s = suggestTemplates({ industries: ["food"], headline: "law" });
    expect(s[0]!.template.tags).toContain("food");
  });

  it("gallery search works in ko/en and by category", () => {
    expect(searchTemplates("블루").map((t) => t.id)).toContain("blueprint");
    expect(searchTemplates("gold").map((t) => t.id)).toContain("noir-gold-foil");
    expect(searchTemplates("변호사").some((t) => t.tags.includes("law"))).toBe(true);
    expect(searchTemplates("", "korean").every((t) => t.category === "korean")).toBe(true);
  });
});

describe("F-021 icon bank", () => {
  it("has ≥240 icons with unique ids and unique path data", () => {
    expect(ICON_BANK.length).toBeGreaterThanOrEqual(240);
    expect(new Set(ICON_BANK.map((i) => i.id)).size).toBe(ICON_BANK.length);
    expect(new Set(ICON_BANK.map((i) => i.d)).size).toBe(ICON_BANK.length);
  });
  it("every icon is valid 24px path data with ko+en keywords and a known category", () => {
    for (const i of ICON_BANK) {
      expect(i.d).toMatch(/^M[-0-9MmLlHhVvCcSsQqAaZz.,\s]+$/);
      expect(i.en.length).toBeGreaterThan(0);
      expect(i.ko.length).toBeGreaterThan(0);
      expect(ICON_CATEGORIES).toContain(i.category);
      // coordinates stay on the 24 grid (the only larger numbers are arc x-axis rotations, ≤ 60°)
      for (const num of i.d.match(/-?\d*\.?\d+/g) ?? []) expect(Math.abs(Number(num))).toBeLessThanOrEqual(60);
    }
    for (const c of ICON_CATEGORIES) expect(ICON_BANK.filter((i) => i.category === c).length).toBeGreaterThanOrEqual(15);
  });
  it("has no third-party brand glyph ids", () => {
    const brands = /facebook|instagram|twitter|linkedin|youtube|tiktok|kakao|naver|github|apple|google|slack|whatsapp|line-app/;
    for (const i of ICON_BANK) expect(i.id).not.toMatch(brands);
  });
  it("searches ko/en keywords", () => {
    expect(searchIcons("법률").map((i) => i.id)).toContain("scale");
    expect(searchIcons("coffee").map((i) => i.id)).toContain("coffee");
    expect(searchIcons("", "korean").every((i) => i.category === "korean")).toBe(true);
    expect(getBankIcon("hanok-roof")?.category).toBe("korean");
  });
});

describe("F-021 emoji bank", () => {
  it("has ≥600 unique emoji, each a single grapheme with ko+en keywords", () => {
    expect(EMOJI_BANK.length).toBeGreaterThanOrEqual(600);
    expect(new Set(EMOJI_BANK.map((e) => e.char)).size).toBe(EMOJI_BANK.length);
    for (const e of EMOJI_BANK) {
      expect(graphemeCount(e.char)).toBe(1);
      expect(e.en.length && e.ko.length).toBeTruthy();
      expect(EMOJI_CATEGORIES).toContain(e.category);
    }
  });
  it("isBankEmoji accepts bank emoji only (single grapheme)", () => {
    expect(isBankEmoji("🚀")).toBe(true);
    expect(isBankEmoji("🧑‍💻")).toBe(true); // ZWJ sequence = one grapheme
    expect(isBankEmoji("🚀🚀")).toBe(false);
    expect(isBankEmoji("a")).toBe(false);
    expect(isBankEmoji("")).toBe(false);
  });
  it("searches ko/en keywords", () => {
    expect(searchEmoji("로켓").map((e) => e.char)).toContain("🚀");
    expect(searchEmoji("coffee").map((e) => e.char)).toContain("☕");
    expect(searchEmoji("", "flags").every((e) => e.category === "flags")).toBe(true);
  });
});

describe("F-021 / F-036 card design options", () => {
  it("validates template id, accent palette, monogram and glyph references", () => {
    expect(validateCardDesign("swiss-grid", { accent: "#1D4ED8", monogram: "JP", icon: "i:rocket", fieldIcons: { email: "e:📧" } })).toEqual([]);
    expect(validateCardDesign("no-such-template", {})).toContain("unknown_template");
    expect(validateCardDesign("swiss-grid", { accent: "#123456" })).toContain("accent_not_allowed");
    expect(validateCardDesign(null, { accent: "#C8321B" })).toContain("accent_without_template");
    expect(validateCardDesign("swiss-grid", { monogram: "ABCD" })).toContain("monogram_invalid");
    expect(validateCardDesign("swiss-grid", { monogram: "<b>" })).toContain("monogram_invalid");
    expect(validateCardDesign("swiss-grid", { icon: "i:not-an-icon" })).toContain("icon_unknown");
    expect(validateCardDesign("swiss-grid", { icon: "e:🚀🚀" })).toContain("icon_unknown");
    expect(validateCardDesign("swiss-grid", { fieldIcons: { fax2: "i:phone" } })).toContain("field_icon_type:fax2");
    expect(validateCardDesign("swiss-grid", { sectionIcons: { projects: "i:rocket", bogus: "i:star" } as never })).toContain("section_icon_key:bogus");
    expect(validateCardDesign("swiss-grid", { keywordBadges: { a: "e:⭐", b: "e:⭐", c: "e:⭐", d: "e:⭐" } })).toContain("keyword_badges_max");
    expect(validateCardDesign(null, null)).toEqual([]);
  });

  it("resolves glyphs to render-ready data and drops unknown refs", () => {
    expect(resolveGlyph("i:mail")).toMatchObject({ kind: "icon", d: getBankIcon("mail")!.d });
    expect(resolveGlyph("e:☕")).toMatchObject({ kind: "emoji", char: "☕" });
    expect(resolveGlyph("x:mail")).toBeNull();
    const d = resolveCardDesign("noir-gold-foil", { accent: "#D8D2C4", icon: "i:gem", sectionIcons: { projects: "e:🚀", achievements: "i:nope" } })!;
    expect(d.template?.id).toBe("noir-gold-foil");
    expect(d.accent).toBe("#D8D2C4");
    expect(d.icon?.kind).toBe("icon");
    expect(Object.keys(d.sectionIcons)).toEqual(["projects"]);
    expect(resolveCardDesign(null, {})).toBeNull();
    expect(resolveCardDesign("unknown", {})).toBeNull();
    expect(resolveCardDesign("swiss-grid", { accent: "#000001" })!.accent).toBeNull();
  });
});
