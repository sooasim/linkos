"use client";
// F-021 / F-022 — single renderer for all 50 card templates (data-driven, CSS/SVG only, no images, no catalog import).
// Sizes are container-query units (cqw) so the 3-second card renders faithfully at sm and lg; the pointer tilt/sheen
// is the same as the classic theme card. Template colors are card-internal (printed object), set as inline styles.
import type { CSSProperties, ReactNode } from "react";
import type { ResolvedCardDesign, ResolvedGlyph } from "@linkos/domain/cardDesign";
import { type CardTemplate, FONT_STACKS, initialsFor, mixHex } from "@linkos/domain/cardTemplateSchema";
import { Icon, type IconName } from "../Icon";
import { Glyph } from "./Glyph";
import { useTilt } from "./useTilt";

export interface TemplateCardData {
  name: string;
  company?: string | null;
  jobTitle?: string | null;
  headline?: string | null;
  keywords?: string[];
  fields?: { type: string; label?: string | null; value: string; visibility?: string }[];
}

const CONTACT_ORDER = ["mobile", "phone", "email", "website", "linkedin", "booking", "address"];
const CONTACT_ICON: Record<string, IconName> = { email: "mail", phone: "phone", mobile: "phone", website: "globe", address: "pin", booking: "calendar", linkedin: "link" };

type Ctx = {
  T: CardTemplate;
  d: ResolvedCardDesign;
  card: TemplateCardData;
  accent: string;
  u: number; // unit multiplier (portrait cards are narrower → larger relative type)
  big: boolean;
  preview: boolean;
};

/** font-size in cqw; on the large card small text never drops below a legible floor */
const fs = (c: Ctx, n: number, floor = 10.5) => (c.big ? `max(${floor}px, ${+(n * c.u).toFixed(2)}cqw)` : `${+(n * c.u).toFixed(2)}cqw`);
const cq = (c: Ctx, n: number) => `${+(n * c.u).toFixed(2)}cqw`;

function svgUrl(svg: string) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function Name({ c, align = "left", scale = 1 }: { c: Ctx; align?: "left" | "center"; scale?: number }) {
  const { T, accent } = c;
  const ty = T.typography;
  const dec = T.decoration;
  const style: CSSProperties = {
    fontFamily: FONT_STACKS[ty.display],
    fontWeight: ty.nameWeight,
    textTransform: ty.nameCase === "upper" ? "uppercase" : undefined,
    letterSpacing: `${ty.nameTracking}em`,
    fontStyle: ty.italic ? "italic" : undefined,
    fontSize: cq(c, 8.4 * ty.nameScale * scale),
    lineHeight: 0.98,
    textAlign: align,
    overflowWrap: "anywhere",
  };
  if (dec.foil) (style as Record<string, string>)["--tc-foil"] = `linear-gradient(100deg, ${dec.foil.join(", ")})`;
  if (dec.emboss) style.textShadow = `0 1px 0 ${mixHex(T.palette.bg, "#ffffff", 0.75)}, 0 -1px 0 ${mixHex(T.palette.bg, "#000000", 0.22)}`;
  if (dec.glow) style.textShadow = `0 0 ${cq(c, 1.8)} ${accent}80, 0 0 ${cq(c, 0.5)} ${accent}66`;
  const Tag = c.preview ? "p" : "h2";
  return (
    <Tag className={dec.foil ? "tc-foil" : undefined} style={style} data-testid="tc-name">
      {c.card.name}
    </Tag>
  );
}

function Meta({ c, align = "left", color }: { c: Ctx; align?: "left" | "center"; color?: string }) {
  const { T, card } = c;
  const parts = [T.show.jobTitle ? card.jobTitle : null, T.show.headline ? card.headline : null].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p style={{ marginTop: cq(c, 1.4), fontSize: fs(c, 2.9), fontWeight: 500, color: color ?? T.palette.fg, opacity: 0.92, textAlign: align, lineHeight: 1.25, fontFamily: FONT_STACKS[T.typography.body] }}>
      {parts.join(" · ")}
    </p>
  );
}

function Company({ c, color, align = "left" }: { c: Ctx; color?: string; align?: "left" | "center" }) {
  const { T, card } = c;
  if (!T.show.company || !card.company) return null;
  return (
    <p style={{ fontSize: fs(c, 2.45), letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, color: color ?? T.palette.muted, textAlign: align, lineHeight: 1.2 }} className="min-w-0 truncate">
      {card.company}
    </p>
  );
}

function Rule({ c, align = "left" }: { c: Ctx; align?: "left" | "center" }) {
  const { T, accent } = c;
  const m = align === "center" ? "auto" : 0;
  const base: CSSProperties = { marginTop: cq(c, 2), marginBottom: cq(c, 0.6), marginLeft: m, marginRight: m };
  switch (T.decoration.rule) {
    case "hairline":
      return <div aria-hidden style={{ ...base, height: 1, width: cq(c, 14), background: accent }} />;
    case "double":
      return <div aria-hidden style={{ ...base, height: 4, width: cq(c, 16), borderTop: `1px solid ${accent}`, borderBottom: `1px solid ${accent}` }} />;
    case "thick":
      return <div aria-hidden style={{ ...base, height: cq(c, 0.9), width: cq(c, 11), background: accent }} />;
    case "dotted":
      return <div aria-hidden style={{ ...base, width: cq(c, 18), borderTop: `2px dotted ${accent}` }} />;
    default:
      return null;
  }
}

function Keywords({ c, align = "left" }: { c: Ctx; align?: "left" | "center" }) {
  const { T, card, d } = c;
  if (!T.show.keywords || !card.keywords?.length) return null;
  return (
    <div className="flex flex-wrap" style={{ gap: cq(c, 1), marginTop: cq(c, 1.8), justifyContent: align === "center" ? "center" : "flex-start" }}>
      {card.keywords.slice(0, 3).map((k) => {
        const g = d.keywordBadges[k];
        return (
          <span key={k} className="inline-flex items-center" style={{ gap: cq(c, 0.6), border: `1px solid ${c.accent}55`, borderRadius: 999, padding: `${cq(c, 0.35)} ${cq(c, 1.3)}`, fontSize: fs(c, 2.15, 10), fontWeight: 500, color: T.palette.fg }}>
            {g ? <Glyph glyph={g} size={cq(c, 2.4)} /> : "#"}
            {k}
          </span>
        );
      })}
    </div>
  );
}

function contactsOf(c: Ctx) {
  return (c.card.fields ?? [])
    .filter((f) => CONTACT_ORDER.includes(f.type) && f.value)
    .sort((a, b) => CONTACT_ORDER.indexOf(a.type) - CONTACT_ORDER.indexOf(b.type))
    .slice(0, c.T.show.contacts);
}

function Contacts({ c, align = "left", inline = false, color }: { c: Ctx; align?: "left" | "right" | "center"; inline?: boolean; color?: string }) {
  const list = contactsOf(c);
  if (!list.length) return null;
  const col = color ?? c.T.palette.fg;
  const icon = (type: string) => {
    const g: ResolvedGlyph | undefined = c.d.fieldIcons[type];
    return g ? <Glyph glyph={g} size={cq(c, 2.5)} style={{ color: c.accent }} /> : <Icon name={CONTACT_ICON[type] ?? "link"} size={12} style={{ width: cq(c, 2.4), height: cq(c, 2.4), color: c.accent }} />;
  };
  return (
    <ul
      className={inline ? "flex flex-wrap" : "flex flex-col"}
      style={{ gap: inline ? `${cq(c, 0.5)} ${cq(c, 2.2)}` : cq(c, 0.8), alignItems: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start", justifyContent: align === "center" ? "center" : undefined, fontSize: fs(c, 2.35, 10), color: col, fontFamily: c.T.typography.body === "mono" ? FONT_STACKS.mono : undefined }}
      data-testid="tc-contacts"
    >
      {list.map((f) => (
        <li key={f.type + f.value} className="inline-flex min-w-0 max-w-full items-center" style={{ gap: cq(c, 0.9), flexDirection: align === "right" ? "row-reverse" : "row" }}>
          {icon(f.type)}
          <span className="truncate">{f.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Monogram({ c, scale = 1, color }: { c: Ctx; scale?: number; color?: string }) {
  const { T, d, accent } = c;
  const text = d.monogram ?? initialsFor(c.card.name);
  if (!text) return null;
  const sz = cq(c, 9 * scale);
  const font: CSSProperties = { fontFamily: FONT_STACKS[T.typography.display], fontSize: cq(c, (text.length > 1 ? 3.4 : 4.4) * scale), lineHeight: 1, fontWeight: 500 };
  const col = color ?? accent;
  switch (T.decoration.monogram) {
    case "circle":
      return <span aria-hidden className="grid place-items-center" style={{ ...font, width: sz, height: sz, borderRadius: 999, border: `1px solid ${col}`, color: col }}>{text}</span>;
    case "square":
      return <span aria-hidden className="grid place-items-center" style={{ ...font, width: sz, height: sz, borderRadius: cq(c, 0.6), background: col, color: T.palette.onAccent }}>{text}</span>;
    case "diamond":
      return (
        <span aria-hidden className="grid place-items-center" style={{ width: sz, height: sz }}>
          <span className="grid place-items-center" style={{ width: "72%", height: "72%", transform: "rotate(45deg)", border: `1px solid ${col}` }}>
            <span style={{ ...font, transform: "rotate(-45deg)", color: col }}>{text}</span>
          </span>
        </span>
      );
    case "crest":
      return (
        <span aria-hidden className="relative grid place-items-center" style={{ width: sz, height: cq(c, 10.5 * scale), color: col }}>
          <svg viewBox="0 0 40 46" className="absolute inset-0 h-full w-full" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M20 2 37 8v14c0 11-7.5 18.5-17 22C10.5 40.5 3 33 3 22V8z" />
            <path d="M20 6.5 33 11v11c0 8.5-5.7 14.3-13 17.2C12.7 36.3 7 30.5 7 22V11z" opacity=".5" />
          </svg>
          <span className="relative" style={{ ...font, color: col }}>{text}</span>
        </span>
      );
    case "plain":
      return <span aria-hidden style={{ ...font, fontSize: cq(c, (text.length > 1 ? 10 : 13) * scale), color: col }}>{text}</span>;
    default:
      return null;
  }
}

/** Icon slot: user's chosen logo glyph, else the template monogram (if any). */
function Mark({ c, color }: { c: Ctx; color?: string }) {
  const { T, d } = c;
  if (T.show.icon && d.icon) return <Glyph glyph={d.icon} size={cq(c, 5.2)} style={{ color: color ?? c.accent }} />;
  if (T.decoration.monogram !== "none") return <Monogram c={c} color={color} />;
  return null;
}

// ── layouts ─────────────────────────────────────────────────────────────
function LayoutClassic({ c }: { c: Ctx }) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="flex items-start justify-between" style={{ gap: cq(c, 3) }}>
        <Company c={c} />
        <Mark c={c} />
      </div>
      <div className="flex items-end justify-between" style={{ gap: cq(c, 3) }}>
        <div className="min-w-0 flex-1">
          <Name c={c} />
          <Meta c={c} />
          <Rule c={c} />
          <Keywords c={c} />
        </div>
        <div className="min-w-0 max-w-[46%] shrink-0">
          <Contacts c={c} align="right" />
        </div>
      </div>
    </div>
  );
}

function LayoutCentered({ c }: { c: Ctx }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center" style={{ gap: cq(c, 0.6) }}>
      <div style={{ marginBottom: cq(c, 1.6) }}>
        <Mark c={c} />
      </div>
      <Name c={c} align="center" />
      <Rule c={c} align="center" />
      <Meta c={c} align="center" />
      <div style={{ marginTop: cq(c, 0.6) }}>
        <Company c={c} align="center" />
      </div>
      <div style={{ marginTop: cq(c, 2.2) }}>
        <Contacts c={c} align="center" inline />
      </div>
    </div>
  );
}

function blockBg(c: Ctx) {
  return c.d.accent && c.d.accent !== c.T.palette.accent ? c.accent : (c.T.block ?? c.accent);
}

function LayoutSplit({ c }: { c: Ctx }) {
  const on = c.T.palette.onAccent;
  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "36% 1fr", margin: `calc(-1 * ${cq(c, 6)})`, height: `calc(100% + 2 * ${cq(c, 6)})` }}>
      <div className="flex flex-col justify-between" style={{ background: blockBg(c), padding: cq(c, 5), color: on }}>
        {c.d.icon && c.T.show.icon ? <Glyph glyph={c.d.icon} size={cq(c, 7)} style={{ color: on }} /> : <Monogram c={{ ...c, T: { ...c.T, decoration: { ...c.T.decoration, monogram: c.T.decoration.monogram === "none" ? "plain" : c.T.decoration.monogram } } }} color={on} scale={1.1} />}
        <Company c={c} color={on} />
      </div>
      <div className="flex min-w-0 flex-col justify-between" style={{ padding: cq(c, 5.5) }}>
        <div>
          <Name c={c} scale={0.92} />
          <Meta c={c} />
          <Rule c={c} />
          <Keywords c={c} />
        </div>
        <Contacts c={c} />
      </div>
    </div>
  );
}

function LayoutRail({ c }: { c: Ctx }) {
  const on = c.T.palette.onAccent;
  return (
    <div className="flex h-full" style={{ margin: `calc(-1 * ${cq(c, 6)})`, height: `calc(100% + 2 * ${cq(c, 6)})` }}>
      <div className="flex flex-col items-center justify-between" style={{ width: cq(c, 12), background: blockBg(c), color: on, padding: `${cq(c, 4)} 0` }}>
        {c.d.icon && c.T.show.icon ? <Glyph glyph={c.d.icon} size={cq(c, 5)} style={{ color: on }} /> : <span />}
        {c.T.show.company && c.card.company ? (
          <span className="truncate" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontSize: fs(c, 2.3), letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 600, maxHeight: "70%" }}>
            {c.card.company}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between" style={{ padding: cq(c, 6) }}>
        <div className="flex justify-end">
          {c.T.decoration.monogram !== "none" ? <Monogram c={c} /> : null}
        </div>
        <div>
          <Name c={c} />
          <Meta c={c} />
          <Rule c={c} />
          <div className="flex items-end justify-between" style={{ gap: cq(c, 2), marginTop: cq(c, 1.6) }}>
            <Keywords c={c} />
            <Contacts c={c} align="right" />
          </div>
        </div>
      </div>
    </div>
  );
}

function LayoutBand({ c }: { c: Ctx }) {
  const on = c.T.palette.onAccent;
  return (
    <div className="flex h-full flex-col" style={{ margin: `calc(-1 * ${cq(c, 6)})`, height: `calc(100% + 2 * ${cq(c, 6)})` }}>
      <div className="flex items-center justify-between" style={{ height: "25%", background: blockBg(c), color: on, padding: `0 ${cq(c, 6)}`, gap: cq(c, 3) }}>
        <Company c={c} color={on} />
        {c.d.icon && c.T.show.icon ? <Glyph glyph={c.d.icon} size={cq(c, 5)} style={{ color: on }} /> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-between" style={{ padding: `${cq(c, 4.5)} ${cq(c, 6)} ${cq(c, 5)}` }}>
        <div>
          <Name c={c} />
          <Meta c={c} />
          <Rule c={c} />
        </div>
        <div className="flex items-end justify-between" style={{ gap: cq(c, 2) }}>
          <Contacts c={c} inline />
          <Keywords c={c} />
        </div>
      </div>
    </div>
  );
}

function LayoutStack({ c }: { c: Ctx }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between">
        <Mark c={c} />
      </div>
      <div className="flex-1" />
      <Name c={c} scale={1.05} />
      <Meta c={c} />
      <Rule c={c} />
      <Keywords c={c} />
      <div style={{ marginTop: cq(c, 4) }}>
        <Contacts c={c} />
      </div>
      <div style={{ marginTop: cq(c, 4) }}>
        <Company c={c} />
      </div>
    </div>
  );
}

function LayoutMonogram({ c }: { c: Ctx }) {
  const text = c.d.monogram ?? initialsFor(c.card.name);
  return (
    <div className="relative flex h-full flex-col justify-between">
      <span aria-hidden className="pointer-events-none absolute select-none" style={{ right: `-${cq(c, 2)}`, top: "50%", transform: "translateY(-54%)", fontFamily: FONT_STACKS[c.T.typography.display], fontSize: cq(c, text.length > 1 ? 30 : 44), lineHeight: 0.8, color: c.accent, opacity: 0.16 }}>
        {text}
      </span>
      <div className="relative flex items-start justify-between" style={{ gap: cq(c, 3) }}>
        <Company c={c} />
        {c.d.icon && c.T.show.icon ? <Glyph glyph={c.d.icon} size={cq(c, 5)} style={{ color: c.accent }} /> : null}
      </div>
      <div className="relative">
        <Name c={c} />
        <Meta c={c} />
        <Rule c={c} />
        <div className="flex items-end justify-between" style={{ gap: cq(c, 2), marginTop: cq(c, 1.2) }}>
          <Keywords c={c} />
          <Contacts c={c} align="right" />
        </div>
      </div>
    </div>
  );
}

function LayoutGrid({ c }: { c: Ctx }) {
  const line = `${c.T.decoration.rule === "thick" ? cq(c, 0.9) : "1px"} solid ${c.accent}`;
  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "1.25fr 1fr", gridTemplateRows: "auto 1fr auto", columnGap: cq(c, 4), borderTop: line, paddingTop: cq(c, 2.6) }}>
      <div className="col-span-2 flex items-start justify-between" style={{ gap: cq(c, 3) }}>
        <Name c={c} />
        <Mark c={c} />
      </div>
      <div className="min-w-0" style={{ paddingTop: cq(c, 0.4) }}>
        <Meta c={c} />
      </div>
      <div className="min-w-0">
        <Keywords c={c} />
      </div>
      <div className="flex min-w-0 items-end" style={{ borderTop: `1px solid ${c.accent}40`, paddingTop: cq(c, 1.6) }}>
        <Company c={c} />
      </div>
      <div className="min-w-0" style={{ borderTop: `1px solid ${c.accent}40`, paddingTop: cq(c, 1.6) }}>
        <Contacts c={c} />
      </div>
    </div>
  );
}

const LAYOUTS: Record<CardTemplate["layout"], (p: { c: Ctx }) => ReactNode> = {
  classic: LayoutClassic,
  centered: LayoutCentered,
  split: LayoutSplit,
  rail: LayoutRail,
  band: LayoutBand,
  stack: LayoutStack,
  monogram: LayoutMonogram,
  grid: LayoutGrid,
};

/** preview: decorative thumbnail inside a gallery button (aria-hidden, no heading, no tilt). */
export function TemplateCard({ card, design, size = "lg", interactive = true, preview = false }: { card: TemplateCardData; design: ResolvedCardDesign; size?: "sm" | "lg"; interactive?: boolean; preview?: boolean }) {
  const tilt = useTilt<HTMLDivElement>(interactive);
  const T = design.template;
  if (!T) return null;
  const portrait = T.orientation === "portrait";
  const c: Ctx = { T, d: design, card, accent: design.accent ?? T.palette.accent, u: portrait ? 1.6 : 1, big: size === "lg", preview };
  const L = LAYOUTS[T.layout];
  const dec = T.decoration;
  const pad = cq(c, 6);
  return (
    <div className={`tc-wrap ${portrait ? (size === "lg" ? "mx-auto w-[min(100%,64%)]" : "mx-auto w-[56%]") : "w-full"}`} data-template={T.id} aria-hidden={preview || undefined}>
      <div
        ref={tilt.ref}
        onPointerMove={preview ? undefined : tilt.onPointerMove}
        onPointerLeave={preview ? undefined : tilt.onPointerLeave}
        className={`card-object ${dec.texture === "grain" ? "grain" : ""} ${portrait ? "aspect-[1/1.62]" : "aspect-[1.62/1]"} w-full`}
        style={{ background: T.background.css, color: T.palette.fg, fontFamily: FONT_STACKS[T.typography.body], borderRadius: cq(c, dec.radius / c.u), textShadow: "none" }}
        data-testid={preview ? "tc-preview" : "card-face"}
        role={preview ? undefined : "group"}
        aria-label={preview ? undefined : `${card.name} 명함 · ${T.name.ko}`}
      >
        {T.background.pattern ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: svgUrl(T.background.pattern), backgroundSize: T.background.patternMode === "tile" ? `${T.background.patternSize}cqw auto` : "cover", backgroundPosition: "center", backgroundRepeat: T.background.patternMode === "tile" ? "repeat" : "no-repeat" }}
          />
        ) : null}
        {T.stripe ? <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0" style={{ height: cq(c, 2.4), background: T.stripe }} /> : null}
        {dec.frame !== "none" ? <div aria-hidden className="pointer-events-none absolute" style={{ inset: cq(c, 2.8), border: dec.frame === "double" ? `3px double ${c.accent}` : `1px solid ${c.accent}`, opacity: 0.6, borderRadius: cq(c, Math.max(0, dec.radius - 1.6) / c.u) }} /> : null}
        {dec.corners ? <Corners c={c} /> : null}
        <div className="sheen" />
        <div className="relative z-[2] h-full" style={{ padding: T.stripe ? `calc(${pad} + ${cq(c, 1.6)}) ${pad} ${pad}` : pad }}>
          {dec.panel ? (
            <div className="tc-glass flex h-full flex-col justify-center" style={{ margin: `calc(-1 * ${cq(c, 1.6)})`, height: `calc(100% + 2 * ${cq(c, 1.6)})`, padding: cq(c, 3), borderRadius: cq(c, 2.4), background: "rgba(255,255,255,.58)", border: "1px solid rgba(255,255,255,.75)" }}>
              <L c={c} />
            </div>
          ) : (
            <L c={c} />
          )}
        </div>
      </div>
    </div>
  );
}

function Corners({ c }: { c: Ctx }) {
  const len = cq(c, 4);
  const inset = cq(c, 2.6);
  const b = `1.5px solid ${c.accent}`;
  const pos: CSSProperties[] = [
    { top: inset, left: inset, borderTop: b, borderLeft: b },
    { top: inset, right: inset, borderTop: b, borderRight: b },
    { bottom: inset, left: inset, borderBottom: b, borderLeft: b },
    { bottom: inset, right: inset, borderBottom: b, borderRight: b },
  ];
  return (
    <>
      {pos.map((p, i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute" style={{ width: len, height: len, opacity: 0.8, ...p }} />
      ))}
    </>
  );
}
