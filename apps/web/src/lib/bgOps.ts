// Canvas renderer for the pure layout ops produced in packages/domain (X-002 가상 배경, X-009 문자 명함 이미지).
// 레이아웃 계산은 도메인(순수 함수)이 하고, 여기서는 받은 op 을 그대로 그린다 — 두 화면이 같은 결과를 내도록 한 곳에 둔다.
import type { BgOp } from "@linkos/domain";

const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Inter Tight", Pretendard, system-ui, sans-serif';

export interface DrawTarget {
  width: number;
  height: number;
  /** Hard cap handed to fillText so an extreme value is condensed instead of running off the canvas. */
  maxTextWidth: number;
}

export function drawOps(ctx: CanvasRenderingContext2D, ops: BgOp[], target: DrawTarget): void {
  const { width, height, maxTextWidth } = target;
  for (const op of ops) {
    if (op.kind === "fill") {
      ctx.fillStyle = op.color;
      ctx.fillRect(0, 0, width, height);
    } else if (op.kind === "gradient") {
      const g = ctx.createLinearGradient(op.x0, op.y0, op.x1, op.y1);
      for (const [at, c] of op.stops) g.addColorStop(at, c);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    } else if (op.kind === "blob") {
      const g = ctx.createRadialGradient(op.x, op.y, 0, op.x, op.y, op.r);
      g.addColorStop(0, op.color);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(op.x - op.r, op.y - op.r, op.r * 2, op.r * 2);
    } else {
      ctx.font = `${op.font === "serif" ? "italic " : ""}${op.weight} ${op.size}px ${op.font === "serif" ? SERIF : SANS}`;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(op.text, op.x, op.y, maxTextWidth);
    }
  }
}

/** Measure function for the domain's fitFontSize (real glyph widths beat the estimate). */
export function canvasMeasure(ctx: CanvasRenderingContext2D): (t: string, s: number) => number {
  return (t, s) => {
    ctx.font = `600 ${s}px ${SANS}`;
    return ctx.measureText(t).width;
  };
}

/** Load the display/UI faces before drawing so the PNG is not rendered with a fallback font. */
export async function ensureCardFonts(): Promise<void> {
  try {
    await Promise.all([document.fonts?.load(`italic 400 96px ${SERIF}`), document.fonts?.load(`600 40px ${SANS}`)]);
  } catch {
    /* fonts are optional — the layout still fits because sizes come from measured widths */
  }
}
