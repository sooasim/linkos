// F-010 자동 테두리/원근/회전 보정, F-013 다중 명함 분리 — synthetic images.
import { describe, expect, it } from "vitest";
import {
  type GrayImage,
  type Point,
  type Quad,
  applyHomography,
  connectedComponents,
  convexHull,
  detectCardQuad,
  findCardRegions,
  homography,
  maxAreaQuad,
  orderQuad,
  otsuThreshold,
  projectionSplit,
  rectifiedSize,
  warpPerspective,
} from "../src";

function inConvex(poly: Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Background + filled convex card polygons; each card gets a dark "logo" block near its first corner and text bars. */
function scene(w: number, h: number, cards: Quad[], bg = 40, fg = 215, noise = 0): GrayImage {
  const data = new Uint8ClampedArray(w * h).fill(bg);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const q of cards) {
    const H = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], q)!;
    const Hi = homography(q, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])!;
    void H;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!inConvex(q, x + 0.5, y + 0.5)) continue;
        const u = applyHomography(Hi, { x: x + 0.5, y: y + 0.5 });
        let v = fg;
        if (u.x > 0.08 && u.x < 0.28 && u.y > 0.1 && u.y < 0.4) v = 30; // logo block (top-left)
        else if (u.x > 0.4 && u.x < 0.9 && ((u.y > 0.55 && u.y < 0.6) || (u.y > 0.7 && u.y < 0.74))) v = 60; // text bars
        data[y * w + x] = v;
      }
  }
  if (noise) for (let i = 0; i < data.length; i++) data[i] = data[i]! + (rnd() - 0.5) * noise;
  return { width: w, height: h, data };
}

const rotRect = (cx: number, cy: number, w: number, h: number, deg: number): Quad => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const).map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c })) as Quad;
};

const maxCornerError = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y)));

describe("F-010 geometry primitives", () => {
  it("homography maps the four source corners onto the destination exactly", () => {
    const src: Quad = [{ x: 12, y: 30 }, { x: 290, y: 8 }, { x: 310, y: 220 }, { x: 5, y: 200 }];
    const dst: Quad = [{ x: 0, y: 0 }, { x: 350, y: 0 }, { x: 350, y: 200 }, { x: 0, y: 200 }];
    const H = homography(src, dst)!;
    src.forEach((p, i) => {
      const q = applyHomography(H, p);
      expect(q.x).toBeCloseTo(dst[i]!.x, 6);
      expect(q.y).toBeCloseTo(dst[i]!.y, 6);
    });
  });

  it("orders corners TL,TR,BR,BL and picks the max-area quad from a hull", () => {
    const q = orderQuad([{ x: 100, y: 90 }, { x: 0, y: 0 }, { x: 0, y: 100 }, { x: 110, y: 5 }]);
    expect(q).toEqual([{ x: 0, y: 0 }, { x: 110, y: 5 }, { x: 100, y: 90 }, { x: 0, y: 100 }]);
    // octagon-ish hull with chamfered corners → quad keeps the 4 dominant corners
    const hull = convexHull([{ x: 0, y: 2 }, { x: 2, y: 0 }, { x: 98, y: 0 }, { x: 100, y: 2 }, { x: 100, y: 58 }, { x: 98, y: 60 }, { x: 2, y: 60 }, { x: 0, y: 58 }, { x: 50, y: 30 }]);
    const best = maxAreaQuad(hull)!;
    expect(best).toHaveLength(4);
    expect(rectifiedSize(best).width).toBeGreaterThanOrEqual(95);
  });

  it("otsu separates a bimodal histogram", () => {
    const v = [...Array(500).fill(40), ...Array(500).fill(210)];
    const t = otsuThreshold(v);
    expect(t).toBeGreaterThan(40);
    expect(t).toBeLessThan(210);
  });
});

describe("F-010 card outline detection + perspective warp", () => {
  it("finds a card rotated by 18° within a few pixels", () => {
    const truth = rotRect(200, 150, 240, 140, 18);
    const img = scene(400, 300, [truth]);
    const d = detectCardQuad(img)!;
    expect(d).not.toBeNull();
    expect(maxCornerError(d.quad, orderQuad(truth))).toBeLessThan(4);
    expect(d.confidence).toBeGreaterThan(0.9);
  });

  it("finds a perspective-distorted card (trapezoid) in a noisy, larger photo", () => {
    const truth: Quad = [{ x: 160, y: 120 }, { x: 640, y: 160 }, { x: 600, y: 470 }, { x: 120, y: 430 }];
    const img = scene(800, 600, [truth], 50, 220, 18);
    const d = detectCardQuad(img)!;
    expect(d).not.toBeNull();
    // work image is downscaled 2× → allow proportionally larger error
    expect(maxCornerError(d.quad, truth)).toBeLessThan(9);
  });

  it("returns null when there is no card outline (blank frame)", () => {
    expect(detectCardQuad({ width: 200, height: 150, data: new Uint8ClampedArray(200 * 150).fill(128) })).toBeNull();
  });

  it("warps the detected quad to an upright rectangle (logo ends up top-left)", () => {
    const truth = rotRect(200, 160, 250, 150, -25);
    const img = scene(420, 320, [truth]);
    const d = detectCardQuad(img)!;
    const size = rectifiedSize(d.quad);
    expect(size.width / size.height).toBeGreaterThan(1.5);
    expect(size.width / size.height).toBeLessThan(1.85);
    const out = warpPerspective({ ...img, channels: 1 }, d.quad, size.width, size.height);
    const at = (u: number, v: number) => out[Math.floor(v * size.height) * size.width + Math.floor(u * size.width)]!;
    expect(at(0.18, 0.25)).toBeLessThan(90); // logo block
    expect(at(0.7, 0.25)).toBeGreaterThan(170); // blank card area
    expect(at(0.6, 0.575)).toBeLessThan(120); // first text bar
    expect(at(0.2, 0.85)).toBeGreaterThan(170);
  });

  it("warps RGBA (4 channels) with bilinear sampling", () => {
    const src = { width: 2, height: 2, channels: 4, data: [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255] };
    const out = warpPerspective(src, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], 2, 2);
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(out.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });
});

describe("F-013 multiple cards in one photo", () => {
  it("separates three cards (two rotated) in reading order", () => {
    const cards = [rotRect(150, 110, 200, 120, 6), rotRect(450, 115, 200, 120, -10), rotRect(300, 320, 210, 125, 3)];
    const img = scene(600, 440, cards, 35, 225, 10);
    const regions = findCardRegions(img);
    expect(regions).toHaveLength(3);
    const centers = regions.map((r) => ({ x: (r.bbox.minX + r.bbox.maxX) / 2, y: (r.bbox.minY + r.bbox.maxY) / 2 }));
    expect(centers[0]!.x).toBeLessThan(250);
    expect(centers[1]!.x).toBeGreaterThan(350);
    expect(centers[2]!.y).toBeGreaterThan(250);
    for (const r of regions) expect(rectifiedSize(r.quad).width).toBeGreaterThan(180);
  });

  it("cuts thin bridges between nearly-touching cards", () => {
    const img = scene(500, 240, [rotRect(130, 120, 200, 120, 0), rotRect(370, 120, 200, 120, 0)], 30, 220);
    // a 2px bright bridge (e.g. a reflection) linking both cards
    for (let x = 229; x < 272; x++) for (let y = 119; y < 121; y++) (img.data as Uint8ClampedArray)[y * 500 + x] = 220;
    expect(findCardRegions(img)).toHaveLength(2);
  });

  it("projection profiles split a mask at empty columns/rows", () => {
    const w = 60;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 28; y++) {
      for (let x = 2; x < 25; x++) mask[y * w + x] = 1;
      for (let x = 32; x < 58; x++) mask[y * w + x] = 1;
    }
    const boxes = projectionSplit(mask, w, { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ minX: 2, maxX: 24 });
    expect(boxes[1]).toMatchObject({ minX: 32, maxX: 57 });
    const cc = connectedComponents(mask, w, h);
    expect(cc.components).toHaveLength(2);
  });
});
