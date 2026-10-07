// F-021 / F-036 — renders a server- or picker-resolved glyph (line icon path or native emoji). No bank import here.
import type { CSSProperties } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";

export function Glyph({ glyph, size = 18, className = "", style, label }: { glyph: ResolvedGlyph; size?: number | string; className?: string; style?: CSSProperties; label?: string }) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (glyph.kind === "emoji") {
    return (
      <span {...a11y} className={`inline-grid shrink-0 place-items-center leading-none ${className}`} style={{ fontSize: typeof size === "number" ? size * 0.92 : size, width: size, height: size, ...style }}>
        {glyph.char}
      </span>
    );
  }
  return (
    <svg {...a11y} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} style={{ width: size, height: size, ...style }}>
      <path d={glyph.d} />
    </svg>
  );
}
