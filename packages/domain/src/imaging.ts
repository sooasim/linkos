// F-010 자동 테두리/크롭/원근/회전 보정, F-013 다중 명함 분리.
// Pure image math on plain arrays (no DOM, no I/O) so it runs in the browser before OCR and is unit-testable
// with synthetic images: edge map → largest convex quadrilateral → homography → perspective warp,
// and binarization + connected components (+ projection split) for several cards in one photo.

export interface GrayImage {
  width: number;
  height: number;
  /** one luminance value (0..255) per pixel, row-major */
  data: Uint8Array | Uint8ClampedArray | Float32Array;
}

export interface Point {
  x: number;
  y: number;
}

/** Corners ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------------------------------------------------------------- basics

export function rgbaToGray(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = rgba[i]! * 0.299 + rgba[i + 1]! * 0.587 + rgba[i + 2]! * 0.114;
  return { width, height, data: out };
}

/** Box-filter downscale so that max(width,height) <= maxSide. Returns the scale factor (small / original). */
export function downscale(img: GrayImage, maxSide: number): { img: GrayImage; scale: number } {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s >= 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const out = new Uint8ClampedArray(w * h);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) {
        sum += img.data[yy * img.width + xx]!;
        n++;
      }
      out[y * w + x] = n ? sum / n : 0;
    }
  }
  return { img: { width: w, height: h, data: out }, scale: w / img.width };
}

/** Separable 5-tap binomial blur ([1 4 6 4 1]/16) with clamped borders. */
export function blur(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2]! * data[y * w + Math.min(w - 1, Math.max(0, x + i))]!;
      tmp[y * w + x] = s / 16;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2]! * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]!;
      out[y * w + x] = s / 16;
    }
  return { width: w, height: h, data: out };
}

/** Sobel gradient magnitude. */
export function sobel(img: GrayImage): Float32Array {
  const { width: w, height: h, data: d } = img;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -d[i - w - 1]! - 2 * d[i - 1]! - d[i + w - 1]! + d[i - w + 1]! + 2 * d[i + 1]! + d[i + w + 1]!;
      const gy = -d[i - w - 1]! - 2 * d[i - w]! - d[i - w + 1]! + d[i + w - 1]! + 2 * d[i + w]! + d[i + w + 1]!;
      out[i] = Math.hypot(gx, gy);
    }
  return out;
}

/** Otsu's threshold over values scaled into 256 bins between 0 and `max`. Returns a value in the input scale. */
export function otsuThreshold(values: ArrayLike<number>, max = 255): number {
  const hist = new Float64Array(256);
  const scale = max > 0 ? 255 / max : 1;
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round(values[i]! * scale)))]!++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return (thr + 0.5) / scale;
}

/** 1 where value > threshold. */
export function threshold(values: ArrayLike<number>, t: number): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! > t ? 1 : 0;
  return out;
}

/** Fraction of border pixels that are set. */
export function borderFill(mask: Uint8Array, w: number, h: number): number {
  let on = 0;
  let n = 0;
  for (let x = 0; x < w; x++) {
    on += mask[x]! + mask[(h - 1) * w + x]!;
    n += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    on += mask[y * w]! + mask[y * w + w - 1]!;
    n += 2;
  }
  return n ? on / n : 0;
}

/** Binary dilation (r=1 → 3x3) or erosion. */
export function morph(mask: Uint8Array, w: number, h: number, op: "dilate" | "erode", r = 1): Uint8Array {
  // separable square structuring element: horizontal then vertical pass
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = op === "dilate" ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? (op === "dilate" ? 0 : 1) : src[yy * w + xx]!;
          if (op === "dilate" && s) {
            v = 1;
            break;
          }
          if (op === "erode" && !s) {
            v = 0;
            break;
          }
        }
        out[y * w + x] = v;
      }
    return out;
  };
  return pass(pass(mask, true), false);
}

// ---------------------------------------------------------------- connected components

export interface Component extends BBox {
  label: number;
  area: number;
  /** per-row leftmost/rightmost pixel — enough to build the convex hull cheaply */
  rows: Map<number, [number, number]>;
}

/** Connected components of set pixels (8-connectivity by default), iterative flood fill. */
export function connectedComponents(mask: Uint8Array, w: number, h: number, connectivity: 4 | 8 = 8): { labels: Int32Array; components: Component[] } {
  const labels = new Int32Array(w * h);
  const components: Component[] = [];
  const stack = new Int32Array(w * h);
  const nb = connectivity === 8 ? [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1] : [-1, 0, 1, 0, 0, -1, 0, 1];
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = ++next;
    const comp: Component = { label, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, rows: new Map() };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    while (sp) {
      const i = stack[--sp]!;
      const x = i % w;
      const y = (i - x) / w;
      comp.area++;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;
      const row = comp.rows.get(y);
      if (!row) comp.rows.set(y, [x, x]);
      else {
        if (x < row[0]) row[0] = x;
        if (x > row[1]) row[1] = x;
      }
      for (let k = 0; k < nb.length; k += 2) {
        const xx = x + nb[k]!;
        const yy = y + nb[k + 1]!;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && !labels[j]) {
          labels[j] = label;
          stack[sp++] = j;
        }
      }
    }
    components.push(comp);
  }
  return { labels, components };
}

// ---------------------------------------------------------------- geometry

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain. Returns the hull counter-clockwise (in y-down image coords: clockwise on screen). */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function componentHull(c: Component): Point[] {
  const pts: Point[] = [];
  for (const [y, [x0, x1]] of c.rows) {
    // pixel corners so that a 1-px wide card edge still has area
    pts.push({ x: x0, y }, { x: x1 + 1, y }, { x: x0, y: y + 1 }, { x: x1 + 1, y: y + 1 });
  }
  return convexHull(pts);
}

/**
 * Largest-area quadrilateral whose vertices are hull vertices.
 * For each diagonal (i, j) the best apex on each side is found by a linear scan; hull sizes are small
 * (rasterized edges), and the hull is pre-thinned to keep this bounded.
 */
export function maxAreaQuad(hull: Point[]): Quad | null {
  let h = hull;
  if (h.length < 4) return null;
  // thin very large hulls by dropping near-collinear vertices
  while (h.length > 120) {
    const keep: Point[] = [];
    for (let i = 0; i < h.length; i++) if (i % 2 === 0 || Math.abs(cross(h[(i - 1 + h.length) % h.length]!, h[i]!, h[(i + 1) % h.length]!)) > 4) keep.push(h[i]!);
    if (keep.length === h.length) break;
    h = keep;
  }
  const n = h.length;
  let best = -1;
  let quad: Point[] | null = null;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      let a1 = -1;
      let k1 = -1;
      for (let k = i + 1; k < j; k++) {
        const a = Math.abs(cross(h[i]!, h[j]!, h[k]!));
        if (a > a1) {
          a1 = a;
          k1 = k;
        }
      }
      let a2 = -1;
      let k2 = -1;
      for (let k = j + 1; k < n + i; k++) {
        const kk = k % n;
        const a = Math.abs(cross(h[i]!, h[j]!, h[kk]!));
        if (a > a2) {
          a2 = a;
          k2 = kk;
        }
      }
      if (k1 < 0 || k2 < 0) continue;
      const area = (a1 + a2) / 2;
      if (area > best) {
        best = area;
        quad = [h[i]!, h[k1]!, h[j]!, h[k2]!];
      }
    }
  return quad ? orderQuad(quad) : null;
}

/** Order 4 points as TL, TR, BR, BL (clockwise on screen starting at the top-left). */
export function orderQuad(pts: Point[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)); // clockwise on screen (y down)
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i]!.x + sorted[i]!.y < sorted[start]!.x + sorted[start]!.y) start = i;
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]!) as Quad;
}

export function isConvexQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i]!, q[(i + 1) % 4]!, q[(i + 2) % 4]!);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size for rectifying a quad: the longer of each pair of opposite edges. */
export function rectifiedSize(q: Quad, maxSide = 0): { width: number; height: number } {
  let width = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let height = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  if (maxSide > 0 && Math.max(width, height) > maxSide) {
    const s = maxSide / Math.max(width, height);
    width *= s;
    height *= s;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// ---------------------------------------------------------------- homography

/** Solve A x = b (n×n) by Gaussian elimination with partial pivoting. Returns null when singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** 3×3 homography H (row-major, h33 = 1) mapping each src[i] to dst[i]. */
export function homography(src: Quad, dst: Quad): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

export function applyHomography(H: number[], p: Point): Point {
  const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
  return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
}

/**
 * Perspective-warp the region `quad` of an interleaved image (channels = 1 for gray, 4 for RGBA)
 * into an upright outW×outH rectangle with bilinear sampling (inverse mapping).
 */
export function warpPerspective(
  src: { width: number; height: number; data: ArrayLike<number>; channels: number },
  quad: Quad,
  outW: number,
  outH: number,
): Uint8ClampedArray {
  const dst: Quad = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = homography(dst, quad); // dst → src
  const ch = src.channels;
  const out = new Uint8ClampedArray(outW * outH * ch);
  if (!H) return out;
  const { width: w, height: h, data } = src;
  for (let y = 0; y < outH; y++)
    for (let x = 0; x < outW; x++) {
      const p = applyHomography(H, { x: x + 0.5, y: y + 0.5 });
      const sx = Math.min(w - 1, Math.max(0, p.x - 0.5));
      const sy = Math.min(h - 1, Math.max(0, p.y - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (y * outW + x) * ch;
      for (let c = 0; c < ch; c++) {
        const a = data[(y0 * w + x0) * ch + c]!;
        const b = data[(y0 * w + x1) * ch + c]!;
        const cc = data[(y1 * w + x0) * ch + c]!;
        const d = data[(y1 * w + x1) * ch + c]!;
        out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      }
    }
  return out;
}

// ---------------------------------------------------------------- detection

export interface QuadDetection {
  quad: Quad;
  /** 0..1 — how rectangular the detected outline is */
  confidence: number;
  method: "edges" | "region";
}

const scaleQuad = (q: Quad, s: number): Quad => q.map((p) => ({ x: p.x / s, y: p.y / s })) as Quad;

function quadFromComponent(c: Component): { quad: Quad; hullArea: number; quadArea: number } | null {
  const hull = componentHull(c);
  const quad = maxAreaQuad(hull);
  if (!quad || !isConvexQuad(quad)) return null;
  return { quad, hullArea: polygonArea(hull), quadArea: polygonArea(quad) };
}

function touchesFrame(q: Quad, w: number, h: number, tol: number): boolean {
  // a "quad" equal to the photo frame is not a detection
  return q.filter((p) => (p.x <= tol || p.x >= w - tol) && (p.y <= tol || p.y >= h - tol)).length >= 3;
}

/**
 * F-010: find the card outline in a photo. Primary method: Sobel edge map → connected edge contours →
 * largest convex quadrilateral that is well-approximated by 4 corners. Fallback: Otsu binarization with the
 * border-majority as background → largest foreground region → quad. Returns corners in input-image coordinates,
 * or null when nothing card-like is found (the caller then uses the full frame).
 */
export function detectCardQuad(gray: GrayImage, opts: { workSize?: number; minAreaFrac?: number } = {}): QuadDetection | null {
  const { img: small, scale } = downscale(gray, opts.workSize ?? 400);
  const w = small.width;
  const h = small.height;
  const minArea = (opts.minAreaFrac ?? 0.12) * w * h;
  const sm = blur(small);
  let best: { quad: Quad; score: number; conf: number; method: QuadDetection["method"] } | null = null;

  // 1) edges
  const mag = sobel(sm);
  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i]! > maxMag) maxMag = mag[i]!;
  if (maxMag > 0) {
    const t = Math.max(otsuThreshold(mag, maxMag), maxMag * 0.12);
    const edges = morph(threshold(mag, t), w, h, "dilate", 1);
    const { components } = connectedComponents(edges, w, h, 8);
    for (const c of components) {
      if ((c.maxX - c.minX) * (c.maxY - c.minY) < minArea) continue;
      const r = quadFromComponent(c);
      if (!r || r.quadArea < minArea) continue;
      const conf = r.quadArea / Math.max(1, r.hullArea);
      if (conf < 0.9 || touchesFrame(r.quad, w, h, 2)) continue;
      if (!best || r.quadArea > best.score) best = { quad: r.quad, score: r.quadArea, conf, method: "edges" };
    }
  }

  // 2) region fallback
  if (!best) {
    const t = otsuThreshold(sm.data);
    let mask = threshold(sm.data, t);
    if (borderFill(mask, w, h) > 0.5) for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 0 : 1;
    mask = morph(morph(mask, w, h, "erode", 1), w, h, "dilate", 1);
    const { components } = connectedComponents(mask, w, h, 8);
    for (const c of components) {
      if (c.area < minArea) continue;
      const r = quadFromComponent(c);
      if (!r) continue;
      const conf = r.quadArea / Math.max(1, r.hullArea);
      if (conf < 0.85 || touchesFrame(r.quad, w, h, 2)) continue;
      if (!best || c.area > best.score) best = { quad: r.quad, score: c.area, conf, method: "region" };
    }
  }
  if (!best) return null;
  return { quad: scaleQuad(best.quad, scale), confidence: Math.round(best.conf * 100) / 100, method: best.method };
}

// ---------------------------------------------------------------- F-013 multiple cards

export interface CardRegion {
  quad: Quad;
  bbox: BBox;
  /** foreground pixels / quad area — low values mean several touching cards or clutter */
  fill: number;
}

/**
 * Split a binary mask region along empty rows/columns (projection profiles). Recurses on both axes.
 * `gapFrac` = a row/column counts as empty when it has ≤ gapFrac × (span) set pixels.
 */
export function projectionSplit(mask: Uint8Array, w: number, box: BBox, opts: { minGap?: number; gapFrac?: number; minSize?: number } = {}, depth = 0): BBox[] {
  const minGap = opts.minGap ?? 3;
  const gapFrac = opts.gapFrac ?? 0.02;
  const minSize = opts.minSize ?? 8;
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  if (depth > 6 || bw < minSize * 2 || bh < minSize * 2) return [box];
  const split = (axis: "x" | "y"): BBox[] | null => {
    const len = axis === "x" ? bw : bh;
    const span = axis === "x" ? bh : bw;
    const prof = new Float32Array(len);
    for (let y = box.minY; y <= box.maxY; y++)
      for (let x = box.minX; x <= box.maxX; x++) if (mask[y * w + x]) prof[axis === "x" ? x - box.minX : y - box.minY]!++;
    const parts: [number, number][] = [];
    let runStart = -1;
    let gap = 0;
    let lastEnd = -1;
    for (let i = 0; i < len; i++) {
      const empty = prof[i]! <= gapFrac * span;
      if (!empty) {
        if (runStart < 0) runStart = i;
        else if (gap >= minGap) {
          parts.push([runStart, lastEnd]);
          runStart = i;
        }
        gap = 0;
        lastEnd = i;
      } else if (runStart >= 0) gap++;
    }
    if (runStart >= 0) parts.push([runStart, lastEnd]);
    const big = parts.filter(([a, b]) => b - a + 1 >= minSize);
    if (big.length < 2) return null;
    return big.map(([a, b]) => (axis === "x" ? { minX: box.minX + a, maxX: box.minX + b, minY: box.minY, maxY: box.maxY } : { minX: box.minX, maxX: box.maxX, minY: box.minY + a, maxY: box.minY + b }));
  };
  const parts = split("x") ?? split("y");
  if (!parts) return [box];
  return parts.flatMap((p) => projectionSplit(mask, w, p, opts, depth + 1));
}

/**
 * F-013: several cards in one photo → one region per card, in reading order (top→bottom, left→right).
 * Otsu binarization (background = border majority) → opening to cut thin bridges → connected components;
 * irregular components (fill < 0.7) are re-split with projection profiles.
 */
export function findCardRegions(gray: GrayImage, opts: { workSize?: number; minAreaFrac?: number; maxCards?: number } = {}): CardRegion[] {
  const { img: small, scale } = downscale(gray, opts.workSize ?? 600);
  const w = small.width;
  const h = small.height;
  const sm = blur(small);
  const t = otsuThreshold(sm.data);
  let mask = threshold(sm.data, t);
  if (borderFill(mask, w, h) > 0.5) for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 0 : 1;
  mask = morph(morph(mask, w, h, "erode", 2), w, h, "dilate", 2);
  const minArea = (opts.minAreaFrac ?? 0.015) * w * h;
  const { components, labels } = connectedComponents(mask, w, h, 8);
  const regions: CardRegion[] = [];
  const pushBox = (box: BBox, compMask: Uint8Array) => {
    // re-derive a component restricted to this box to get its hull
    const sub = new Uint8Array(w * h);
    let area = 0;
    for (let y = box.minY; y <= box.maxY; y++)
      for (let x = box.minX; x <= box.maxX; x++)
        if (compMask[y * w + x]) {
          sub[y * w + x] = 1;
          area++;
        }
    if (area < minArea) return;
    const { components: cs } = connectedComponents(sub, w, h, 8);
    const c = cs.sort((a, b) => b.area - a.area)[0];
    if (!c || c.area < minArea) return;
    const r = quadFromComponent(c);
    if (!r) return;
    regions.push({ quad: scaleQuad(r.quad, scale), bbox: { minX: c.minX / scale, minY: c.minY / scale, maxX: (c.maxX + 1) / scale, maxY: (c.maxY + 1) / scale }, fill: Math.round((c.area / Math.max(1, r.quadArea)) * 100) / 100 });
  };
  for (const c of components) {
    if (c.area < minArea) continue;
    const compMask = new Uint8Array(w * h);
    for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) if (labels[y * w + x] === c.label) compMask[y * w + x] = 1;
    const r = quadFromComponent(c);
    const fill = r ? c.area / Math.max(1, r.quadArea) : 0;
    if (r && fill >= 0.7) {
      regions.push({ quad: scaleQuad(r.quad, scale), bbox: { minX: c.minX / scale, minY: c.minY / scale, maxX: (c.maxX + 1) / scale, maxY: (c.maxY + 1) / scale }, fill: Math.round(fill * 100) / 100 });
      continue;
    }
    for (const box of projectionSplit(compMask, w, c, { minSize: Math.max(8, Math.round(Math.min(w, h) * 0.05)) })) pushBox(box, compMask);
  }
  const rowTol = 0.25 * h / scale;
  regions.sort((a, b) => {
    const ay = (a.bbox.minY + a.bbox.maxY) / 2;
    const by = (b.bbox.minY + b.bbox.maxY) / 2;
    if (Math.abs(ay - by) > rowTol) return ay - by;
    return a.bbox.minX - b.bbox.minX;
  });
  return regions.slice(0, opts.maxCards ?? 12);
}
