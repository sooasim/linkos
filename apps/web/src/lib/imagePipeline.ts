"use client";
// F-010 자동 테두리/크롭/원근/회전/명암 보정, F-013 다중 명함 분리 — on-device (browser canvas).
// The geometry (edge map → largest convex quad → homography → warp; binarization + connected components)
// lives in @linkos/domain as pure, unit-tested functions; this file only moves pixels in and out of canvases.
import { type CardRegion, type Quad, type QuadDetection, detectCardQuad, findCardRegions, rectifiedSize, rgbaToGray, warpPerspective } from "@linkos/domain";

export async function loadCanvas(file: Blob, maxSide = 2000): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext("2d", { willReadFrequently: true })!;
}

function grayOf(canvas: HTMLCanvasElement) {
  const img = ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  return { img, gray: rgbaToGray(img.data, canvas.width, canvas.height) };
}

/** Warp `quad` of `src` into a new upright canvas (long side ≤ maxSide). */
export function warpToCanvas(src: HTMLCanvasElement, quad: Quad, maxSide = 1600): HTMLCanvasElement {
  const img = ctx2d(src).getImageData(0, 0, src.width, src.height);
  const { width, height } = rectifiedSize(quad, maxSide);
  const out = warpPerspective({ width: src.width, height: src.height, data: img.data, channels: 4 }, quad, width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  ctx2d(c).putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return c;
}

/** F-010: detect the card outline and rectify it; returns the original canvas when no outline is found. */
export function autoCorrect(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; detection: QuadDetection | null } {
  const { gray } = grayOf(canvas);
  const detection = detectCardQuad(gray);
  if (!detection) return { canvas, detection: null };
  return { canvas: warpToCanvas(canvas, detection.quad), detection };
}

/** F-013: one rectified canvas per card found in the photo (reading order). */
export function splitCards(canvas: HTMLCanvasElement): { canvases: HTMLCanvasElement[]; regions: CardRegion[] } {
  const { gray } = grayOf(canvas);
  const regions = findCardRegions(gray);
  if (regions.length <= 1) {
    const one = autoCorrect(canvas);
    return { canvases: [one.canvas], regions };
  }
  return { canvases: regions.map((r) => warpToCanvas(canvas, r.quad)), regions };
}

/** 명암 보정: grayscale + 2–98 percentile contrast stretch (copy). */
export function enhanceForOcr(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = ctx2d(c);
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    hist[v]!++;
  }
  const total = c.width * c.height;
  let lo = 0;
  let hi = 255;
  for (let acc = 0, i = 0; i < 256; i++) if ((acc += hist[i]!) > total * 0.02) { lo = i; break; }
  for (let acc = 0, i = 255; i >= 0; i--) if ((acc += hist[i]!) > total * 0.02) { hi = i; break; }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, ((d[i]! - lo) * 255) / range));
  g.putImageData(img, 0, 0);
  return c;
}

export function canvasToJpeg(c: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality));
}

export function thumbnail(c: HTMLCanvasElement, max = 360): string {
  const s = Math.min(1, max / Math.max(c.width, c.height));
  const t = document.createElement("canvas");
  t.width = Math.round(c.width * s);
  t.height = Math.round(c.height * s);
  t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.75);
}
