// X-001 email signature · X-002 virtual background layout · X-004 wallet pass builders · X-007 poster layout.
// Pure functions only (no I/O). Every value comes from the owner's own Living Card — nothing is generated or guessed.

// ---------------------------------------------------------------- shared helpers

/** Escape text for HTML element content AND attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only allow http(s)/mailto/tel links; anything else (javascript:, data:, vbscript:, relative) is dropped. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || /[\s<>"'`]/.test(v)) return null;
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(v)) return v;
  if (/^tel:\+?[0-9()\-.]{3,24}$/i.test(v)) return v;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Tracked link to the public Living Card. `src` is a fixed enum (never user data) so the count carries no PII. */
export type TrackedSource = "sig" | "bg" | "wallet";
export function trackedCardUrl(origin: string, slug: string, src: TrackedSource): string {
  return `${origin.replace(/\/$/, "")}/p/${encodeURIComponent(slug)}?src=${src}`;
}

export interface ShareCard {
  name: string;
  jobTitle?: string | null;
  company?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

// ---------------------------------------------------------------- X-001 email signature

export const SIGNATURE_STYLES = ["classic", "compact", "pastel"] as const;
export type SignatureStyle = (typeof SIGNATURE_STYLES)[number];

/** Email clients ignore CSS variables, so the design tokens are inlined here as literals (Porcelain & Pastel). */
const SIG = { ink: "#1B1B24", mute: "#6A6A7C", iris: "#5B4BD6", lavender: "#ECE8FF", line: "#E6E6EF" } as const;

export interface Signature {
  style: SignatureStyle;
  html: string;
  text: string;
}

function contactLines(c: ShareCard): { label: string; text: string; href: string | null }[] {
  const out: { label: string; text: string; href: string | null }[] = [];
  if (c.email) out.push({ label: "E", text: c.email, href: safeHref(`mailto:${c.email}`) });
  if (c.phone) out.push({ label: "T", text: c.phone, href: safeHref(`tel:${c.phone.replace(/[^\d+]/g, "")}`) });
  if (c.website) {
    const href = safeHref(c.website);
    out.push({ label: "W", text: href ? displayUrl(href) : c.website, href });
  }
  return out;
}

function a(href: string | null, text: string, color: string): string {
  const t = escapeHtml(text);
  return href ? `<a href="${escapeHtml(href)}" style="color:${color};text-decoration:none">${t}</a>` : t;
}

export function buildEmailSignature(card: ShareCard, cardUrl: string, style: SignatureStyle): Signature {
  const link = safeHref(cardUrl);
  const role = [card.jobTitle, card.company].filter(Boolean).join(" · ");
  const lines = contactLines(card);
  const font = "font-family:-apple-system,'Segoe UI',Pretendard,'Apple SD Gothic Neo',Arial,sans-serif";
  const name = escapeHtml(card.name);
  const cta = link ? a(link, "Living Card 보기 →", SIG.iris) : "";

  let html: string;
  if (style === "compact") {
    const bits = [`<b style="color:${SIG.ink}">${name}</b>`, role ? escapeHtml(role) : null, ...lines.map((l) => a(l.href, l.text, SIG.mute)), cta || null].filter(Boolean);
    html = `<p style="margin:0;${font};font-size:12px;line-height:1.5;color:${SIG.mute}">${bits.join(` <span style="color:${SIG.line}">|</span> `)}</p>`;
  } else if (style === "pastel") {
    const rows = lines.map((l) => `<tr><td style="padding:0 8px 0 0;color:${SIG.iris};font-weight:600">${l.label}</td><td>${a(l.href, l.text, SIG.ink)}</td></tr>`).join("");
    html =
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${font};font-size:13px;line-height:1.5;color:${SIG.ink};background:${SIG.lavender};border-radius:14px">` +
      `<tr><td style="padding:14px 18px">` +
      `<div style="font-size:17px;font-weight:700;color:${SIG.ink}">${name}</div>` +
      (role ? `<div style="color:${SIG.mute};margin-top:2px">${escapeHtml(role)}</div>` : "") +
      (rows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;font-size:13px">${rows}</table>` : "") +
      (cta ? `<div style="margin-top:10px;font-weight:600">${cta}</div>` : "") +
      `</td></tr></table>`;
  } else {
    const rows = lines.map((l) => `<div>${a(l.href, l.text, SIG.mute)}</div>`).join("");
    html =
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${font};font-size:13px;line-height:1.55;color:${SIG.ink}">` +
      `<tr><td style="padding:0 14px 0 0;border-right:2px solid ${SIG.iris}"><div style="font-size:16px;font-weight:700">${name}</div>` +
      (role ? `<div style="color:${SIG.mute}">${escapeHtml(role)}</div>` : "") +
      `</td><td style="padding:0 0 0 14px;color:${SIG.mute}">${rows}${cta ? `<div style="margin-top:4px;font-weight:600">${cta}</div>` : ""}</td></tr></table>`;
  }

  const textLines = [card.name, role || null, ...lines.map((l) => `${l.label}: ${l.text}`), link ? `Living Card: ${link}` : null].filter(Boolean) as string[];
  const text = style === "compact" ? textLines.join(" | ") : ["--", ...textLines].join("\n");
  return { style, html, text };
}

export function buildEmailSignatures(card: ShareCard, cardUrl: string): Signature[] {
  return SIGNATURE_STYLES.map((s) => buildEmailSignature(card, cardUrl, s));
}

// ---------------------------------------------------------------- X-002 virtual background

export const BG_WIDTH = 1920;
export const BG_HEIGHT = 1080;
export type BackgroundStyle = "pastel" | "dark";

export type BgOp =
  | { kind: "fill"; color: string }
  | { kind: "gradient"; x0: number; y0: number; x1: number; y1: number; stops: [number, string][] }
  | { kind: "blob"; x: number; y: number; r: number; color: string }
  | { kind: "text"; text: string; x: number; y: number; size: number; weight: 400 | 600 | 700; color: string; font: "serif" | "sans"; align: "left" | "right" };

/** Rough width estimate used when no canvas is available (CJK glyphs ≈ 1em, latin ≈ .56em). */
export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 1 : /[A-Z0-9@]/.test(ch) ? 0.64 : 0.54;
  return em * size;
}

/** Largest font size ≤ max that fits `maxWidth` (never below min — long text is then clipped by the caller). */
export function fitFontSize(text: string, max: number, min: number, maxWidth: number, measure: (t: string, s: number) => number = estimateTextWidth): number {
  let s = max;
  while (s > min && measure(text, s) > maxWidth) s -= 2;
  return s;
}

/**
 * Text sits in the upper-right band so the person (centre/bottom of a webcam frame) does not cover it.
 * Video apps mirror the self-view only, so the rendered PNG keeps normal reading order.
 */
export function backgroundLayout(card: ShareCard, link: string, style: BackgroundStyle, measure?: (t: string, s: number) => number): BgOp[] {
  const pastel = style === "pastel";
  const ink = pastel ? "#1B1B24" : "#EEEDF6";
  const mute = pastel ? "#6A6A7C" : "#A3A2B8";
  const accent = pastel ? "#5B4BD6" : "#B8ADFF";
  const ops: BgOp[] = [
    { kind: "fill", color: pastel ? "#FCFCFE" : "#0F0F17" },
    { kind: "gradient", x0: 0, y0: 0, x1: BG_WIDTH, y1: BG_HEIGHT, stops: pastel ? [[0, "#ECE8FF"], [0.55, "#FCFCFE"], [1, "#DCF5EA"]] : [[0, "#171724"], [1, "#0F0F17"]] },
    { kind: "blob", x: 1680, y: 120, r: 420, color: pastel ? "rgba(253,230,239,0.85)" : "rgba(165,151,255,0.18)" },
    { kind: "blob", x: 220, y: 980, r: 360, color: pastel ? "rgba(220,235,255,0.9)" : "rgba(220,245,234,0.08)" },
  ];
  const right = BG_WIDTH - 96;
  const maxW = 820;
  const nameSize = fitFontSize(card.name, 96, 48, maxW, measure);
  ops.push({ kind: "text", text: card.name, x: right, y: 190, size: nameSize, weight: 400, color: ink, font: "serif", align: "right" });
  let y = 190 + Math.round(nameSize * 0.72);
  const role = [card.jobTitle, card.company].filter(Boolean).join(" · ");
  if (role) {
    const s = fitFontSize(role, 40, 24, maxW, measure);
    ops.push({ kind: "text", text: role, x: right, y, size: s, weight: 600, color: mute, font: "sans", align: "right" });
    y += Math.round(s * 1.5);
  }
  if (card.headline) {
    const s = fitFontSize(card.headline, 30, 20, maxW, measure);
    ops.push({ kind: "text", text: card.headline, x: right, y, size: s, weight: 400, color: mute, font: "sans", align: "right" });
    y += Math.round(s * 1.5);
  }
  const shown = displayUrl(link);
  ops.push({ kind: "text", text: shown, x: right, y: y + 12, size: fitFontSize(shown, 30, 18, maxW, measure), weight: 600, color: accent, font: "sans", align: "right" });
  return ops;
}

// ---------------------------------------------------------------- X-004 wallet passes

export interface PassCard extends ShareCard {
  profileId: string;
  cardUrl: string;
}

export interface ApplePassConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName?: string;
}

/** Apple Wallet pass.json (generic style). The barcode is only a fallback: the pass also carries the plain link. */
export function buildApplePassJson(card: PassCard, cfg: ApplePassConfig, serialNumber: string): Record<string, unknown> {
  const link = safeHref(card.cardUrl) ?? card.cardUrl;
  const secondary = [card.jobTitle ? { key: "title", label: "TITLE", value: card.jobTitle } : null, card.company ? { key: "company", label: "COMPANY", value: card.company } : null].filter(Boolean);
  const auxiliary = [card.email ? { key: "email", label: "EMAIL", value: card.email } : null, card.phone ? { key: "phone", label: "PHONE", value: card.phone } : null].filter(Boolean);
  const back = [
    { key: "card", label: "Living Card", value: link, attributedValue: `<a href='${escapeHtml(link)}'>${escapeHtml(displayUrl(link))}</a>` },
    ...(card.website ? [{ key: "website", label: "Website", value: card.website }] : []),
    { key: "about", label: "LINKOS", value: "이 패스는 내 Living Card로 연결됩니다. 정보가 바뀌면 링크의 카드가 최신 상태입니다." },
  ];
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeIdentifier,
    teamIdentifier: cfg.teamIdentifier,
    serialNumber,
    organizationName: cfg.organizationName ?? "LINKOS",
    description: `${card.name} · Living Card`,
    logoText: "LINKOS",
    foregroundColor: "rgb(27, 27, 36)",
    labelColor: "rgb(91, 75, 214)",
    backgroundColor: "rgb(236, 232, 255)",
    sharingProhibited: false,
    generic: {
      primaryFields: [{ key: "name", label: "NAME", value: card.name }],
      secondaryFields: secondary,
      auxiliaryFields: auxiliary,
      backFields: back,
    },
    barcodes: [{ format: "PKBarcodeFormatQR", message: link, messageEncoding: "iso-8859-1", altText: displayUrl(link) }],
  };
}

const PASS_TYPE_ID = /^pass\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export function validateApplePassJson(p: Record<string, any>): string[] {
  const errs: string[] = [];
  if (p.formatVersion !== 1) errs.push("formatVersion");
  if (typeof p.passTypeIdentifier !== "string" || !PASS_TYPE_ID.test(p.passTypeIdentifier)) errs.push("passTypeIdentifier");
  if (typeof p.teamIdentifier !== "string" || !TEAM_ID.test(p.teamIdentifier)) errs.push("teamIdentifier");
  if (typeof p.serialNumber !== "string" || p.serialNumber.length < 8) errs.push("serialNumber");
  if (!p.organizationName) errs.push("organizationName");
  if (!p.description) errs.push("description");
  if (!p.generic?.primaryFields?.length) errs.push("generic.primaryFields");
  for (const k of ["foregroundColor", "labelColor", "backgroundColor"]) if (!/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/.test(String(p[k]))) errs.push(k);
  const keys = new Set<string>();
  for (const group of ["primaryFields", "secondaryFields", "auxiliaryFields", "backFields"]) {
    for (const f of p.generic?.[group] ?? []) {
      if (keys.has(f.key)) errs.push(`duplicate key ${f.key}`);
      keys.add(f.key);
    }
  }
  return errs;
}

/** manifest.json: SHA-1 (hex) of every file in the pass bundle. Hashing is injected (no node:crypto here). */
export function passManifest(files: Record<string, Uint8Array>, sha1Hex: (b: Uint8Array) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) {
    if (name === "manifest.json" || name === "signature") continue;
    out[name] = sha1Hex(files[name]!);
  }
  return out;
}

export const PASS_IMAGES = ["icon.png", "icon@2x.png", "logo.png", "logo@2x.png"] as const;

/** Google Wallet ids are `<issuerId>.<suffix>` with suffix limited to [A-Za-z0-9._-]. */
export function googleWalletId(issuerId: string, suffix: string): string {
  return `${issuerId}.${suffix.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;
}

/** Google Wallet "generic object" for the card (class: `<issuer>.linkos_living_card`). */
export function buildGoogleGenericObject(card: PassCard, issuerId: string): Record<string, unknown> {
  const link = safeHref(card.cardUrl) ?? card.cardUrl;
  const text = (header: string, body: string, id: string) => ({ id, header, body });
  return {
    id: googleWalletId(issuerId, `card_${card.profileId}`),
    classId: googleWalletId(issuerId, "linkos_living_card"),
    state: "ACTIVE",
    genericType: "GENERIC_TYPE_UNSPECIFIED",
    hexBackgroundColor: "#ECE8FF",
    cardTitle: { defaultValue: { language: "ko", value: "LINKOS Living Card" } },
    header: { defaultValue: { language: "ko", value: card.name } },
    ...(card.jobTitle || card.company ? { subheader: { defaultValue: { language: "ko", value: [card.jobTitle, card.company].filter(Boolean).join(" · ") } } } : {}),
    textModulesData: [card.email ? text("Email", card.email, "email") : null, card.phone ? text("Phone", card.phone, "phone") : null].filter(Boolean),
    linksModuleData: { uris: [{ uri: link, description: "Living Card", id: "card" }] },
    barcode: { type: "QR_CODE", value: link, alternateText: displayUrl(link) },
  };
}

// ---------------------------------------------------------------- X-007 poster / table tent

export type PosterSize = "a6" | "a4";
/** PDF points (1/72 in). */
export const POSTER_SIZES: Record<PosterSize, { w: number; h: number }> = { a6: { w: 297.64, h: 419.53 }, a4: { w: 595.28, h: 841.89 } };

/** "1234" → "12 34" (4-digit exchange code read aloud as two pairs); longer codes in groups of three. */
export function formatShortCode(code: string): string {
  const c = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (c.length === 4) return `${c.slice(0, 2)} ${c.slice(2)}`;
  return c.length > 3 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

export interface PosterLayout {
  w: number;
  h: number;
  margin: number;
  nameSize: number;
  roleSize: number;
  codeLabelY: number;
  codeY: number;
  codeSize: number;
  urlY: number;
  urlSize: number;
  qr: { x: number; y: number; size: number };
}

/**
 * CLAUDE.md rule 3: the short code is the hero; the QR is a small fallback in the bottom corner
 * (always < 1/4 of the page width and smaller than the code's cap height × 3).
 */
export function posterLayout(size: PosterSize): PosterLayout {
  const { w, h } = POSTER_SIZES[size];
  const k = w / POSTER_SIZES.a6.w;
  const margin = 24 * k;
  const codeSize = 64 * k;
  const qrSize = Math.min(w * 0.2, codeSize * 1.4);
  return {
    w,
    h,
    margin,
    nameSize: 26 * k,
    roleSize: 12 * k,
    codeLabelY: h * 0.44,
    codeY: h * 0.44 + 18 * k,
    codeSize,
    urlY: h * 0.44 + 18 * k + codeSize + 10 * k,
    urlSize: 11 * k,
    qr: { x: w - margin - qrSize, y: h - margin - qrSize, size: qrSize },
  };
}
