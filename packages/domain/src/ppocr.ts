// F-015 다국어 OCR — PP-OCRv5(PaddleOCR) 파이프라인의 순수 계산부.
//
// 명함 인식의 정확도 천장은 파서가 아니라 글자를 읽는 엔진이 정한다(KBT 2026-10 측정:
// 분류 손실 ≈ 0, holdout 84.4% / OCR 천장 84.9%). tesseract 는 한국어 명함에서 음절을
// 흘리고 띄어 읽는다. PaddleOCR 의 PP-OCRv5 한국어 인식 모델은 같은 과제에서 공개 지표
// 88.0% 를 보고하므로, 엔진을 바꾸면 천장 자체가 올라간다.
//
// 모델 실행(onnxruntime-web)은 apps/web 의 어댑터가 하고, 전처리·DB 후처리·CTC 디코딩은
// 전부 여기 둔다 — I/O·DOM 없는 순수 함수라야 단위테스트로 고정할 수 있다(CLAUDE.md §4).
// 상수와 절차는 PaddleOCR 추론 설정(det: limit_type=min/736, thresh 0.3, box_thresh 0.6,
// unclip_ratio 1.5 / rec: 3×48×W, (x/255-0.5)/0.5, CTC blank=0)을 그대로 따른다.
import { type Point, type Quad, componentHull, connectedComponents, convexHull, orderQuad, polygonArea } from "./imaging";

export interface RgbaImage {
  width: number;
  height: number;
  /** interleaved RGBA, row-major */
  data: ArrayLike<number>;
}

// ---------------------------------------------------------------- detection input

/** DBNet 입력 정규화 상수 (PaddleOCR NormalizeImage, ImageNet 평균/표준편차) */
export const DET_MEAN = [0.485, 0.456, 0.406] as const;
export const DET_STD = [0.229, 0.224, 0.225] as const;

export interface DetResize {
  width: number;
  height: number;
  /** 원본 좌표로 되돌릴 때 쓰는 비율 (원본 / 입력) */
  ratioX: number;
  ratioY: number;
}

/**
 * 검출 모델 입력 크기. PP-OCRv5 기본값은 limit_type="min", limit_side_len=736 이다 —
 * 짧은 변을 736 이상으로 맞추고(작으면 키우고) 32 의 배수로 떨어뜨린다.
 * 긴 변이 maxSide 를 넘으면 그쪽을 기준으로 다시 줄인다.
 */
export function detResize(width: number, height: number, opts: { limitSideLen?: number; limitType?: "min" | "max"; maxSide?: number } = {}): DetResize {
  const limit = opts.limitSideLen ?? 736;
  const type = opts.limitType ?? "min";
  const maxSide = opts.maxSide ?? 4000;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let ratio = 1;
  if (type === "min") {
    if (Math.min(w, h) < limit) ratio = limit / Math.min(w, h);
  } else if (Math.max(w, h) > limit) ratio = limit / Math.max(w, h);
  if (Math.max(w, h) * ratio > maxSide) ratio = maxSide / Math.max(w, h);
  const snap = (v: number) => Math.max(32, Math.round((v * ratio) / 32) * 32);
  const outW = snap(w);
  const outH = snap(h);
  return { width: outW, height: outH, ratioX: w / outW, ratioY: h / outH };
}

/** RGBA → CHW Float32 (RGB, (v/255 - mean) / std). 입력은 이미 모델 크기로 줄여 둔 것이다. */
export function normalizeDetInput(img: RgbaImage): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    for (let c = 0; c < 3; c++) out[c * plane + p] = (data[i + c]! / 255 - DET_MEAN[c]!) / DET_STD[c]!;
  }
  return out;
}

// ---------------------------------------------------------------- geometry

export interface MinRect {
  quad: Quad;
  width: number;
  height: number;
  center: Point;
  /** 긴 변 방향 단위벡터 */
  ux: number;
  uy: number;
}

const rectQuad = (center: Point, ux: number, uy: number, halfW: number, halfH: number): Quad =>
  orderQuad([
    { x: center.x - ux * halfW + uy * halfH, y: center.y - uy * halfW - ux * halfH },
    { x: center.x + ux * halfW + uy * halfH, y: center.y + uy * halfW - ux * halfH },
    { x: center.x + ux * halfW - uy * halfH, y: center.y + uy * halfW + ux * halfH },
    { x: center.x - ux * halfW - uy * halfH, y: center.y - uy * halfW + ux * halfH },
  ]);

/**
 * 최소면적 외접 직사각형 (rotating calipers). 볼록껍질의 각 변을 축으로 삼아
 * 투영 폭·높이를 재고 면적이 가장 작은 쪽을 고른다 — OpenCV minAreaRect 와 같은 결과.
 */
export function minAreaRect(points: Point[]): MinRect | null {
  const hull = points.length > 4 ? convexHull(points) : points;
  if (hull.length < 2) return null;
  let best: { area: number; ux: number; uy: number; u0: number; u1: number; v0: number; v1: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let u0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const uc = (best.u0 + best.u1) / 2;
  const vc = (best.v0 + best.v1) / 2;
  const center = { x: uc * best.ux - vc * best.uy, y: uc * best.uy + vc * best.ux };
  const width = best.u1 - best.u0;
  const height = best.v1 - best.v0;
  return { quad: rectQuad(center, best.ux, best.uy, width / 2, height / 2), width, height, center, ux: best.ux, uy: best.uy };
}

/**
 * DB 후처리의 unclip — 글자 획만 남은 확률맵은 실제 글자보다 좁아서, 면적/둘레로
 * 구한 거리만큼 네 변을 바깥으로 민다(PaddleOCR 은 pyclipper, 직사각형에서는 같은 값).
 */
export function unclipRect(rect: MinRect, unclipRatio = 1.5): Quad {
  const area = polygonArea(rect.quad);
  const perimeter = 2 * (rect.width + rect.height);
  const d = perimeter > 0 ? (area * unclipRatio) / perimeter : 0;
  return rectQuad(rect.center, rect.ux, rect.uy, rect.width / 2 + d, rect.height / 2 + d);
}

const sideSign = (q: Quad, i: number, p: Point) => {
  const a = q[i]!;
  const b = q[(i + 1) % 4]!;
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
};

/** 볼록 사각형 내부(경계 포함) 판정 */
export function pointInQuad(q: Quad, p: Point): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const s = sideSign(q, i, p);
    if (Math.abs(s) < 1e-9) continue;
    const cur = s > 0 ? 1 : -1;
    if (sign && cur !== sign) return false;
    sign = cur;
  }
  return true;
}

/** 사각형 내부 확률의 평균 (PaddleOCR box_score_fast) */
export function boxScore(prob: ArrayLike<number>, width: number, height: number, quad: Quad): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!pointInQuad(quad, { x: x + 0.5, y: y + 0.5 })) continue;
      sum += prob[y * width + x]!;
      n++;
    }
  return n ? sum / n : 0;
}

// ---------------------------------------------------------------- DB post-processing

export interface DetBox {
  /** 원본 이미지 좌표의 네 꼭짓점 (TL, TR, BR, BL) */
  quad: Quad;
  /** 0..1 — 확률맵 평균 */
  score: number;
}

export interface DbOptions {
  /** 글자 화소 판정 임계값 */
  thresh?: number;
  /** 상자 평균 확률 임계값 */
  boxThresh?: number;
  unclipRatio?: number;
  /** 확률맵 좌표에서 이 픽셀보다 얇은 상자는 버린다 */
  minSide?: number;
  maxCandidates?: number;
}

/**
 * 확률맵 → 글자줄 상자. 임계값으로 이진화하고 연결성분을 잡아 각 성분의 최소면적
 * 직사각형을 구한 뒤, 평균 확률로 거르고 unclip 으로 넓힌다. `ratioX/ratioY` 를 주면
 * 원본 이미지 좌표로 되돌린다.
 */
export function dbBoxes(prob: ArrayLike<number>, width: number, height: number, resize?: Pick<DetResize, "ratioX" | "ratioY">, opts: DbOptions = {}): DetBox[] {
  const thresh = opts.thresh ?? 0.3;
  const boxThresh = opts.boxThresh ?? 0.6;
  const unclipRatio = opts.unclipRatio ?? 1.5;
  const minSide = opts.minSide ?? 3;
  const rx = resize?.ratioX ?? 1;
  const ry = resize?.ratioY ?? 1;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = (prob[i] ?? 0) > thresh ? 1 : 0;
  const { components } = connectedComponents(mask, width, height, 8);
  const out: DetBox[] = [];
  const ranked = components.sort((a, b) => b.area - a.area).slice(0, opts.maxCandidates ?? 1000);
  for (const c of ranked) {
    if (c.area < minSide * minSide) continue;
    const rect = minAreaRect(componentHull(c));
    if (!rect || Math.min(rect.width, rect.height) < minSide) continue;
    const score = boxScore(prob, width, height, rect.quad);
    if (score < boxThresh) continue;
    const quad = unclipRect(rect, unclipRatio).map((p) => ({ x: p.x * rx, y: p.y * ry })) as Quad;
    out.push({ quad: orderQuad(quad), score: Math.round(score * 1000) / 1000 });
  }
  return out;
}

const quadHeight = (q: Quad) => (Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y) + Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y)) / 2;
const quadWidth = (q: Quad) => (Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) + Math.hypot(q[3].x - q[2].x, q[3].y - q[2].y)) / 2;

export const boxSize = (q: Quad) => ({ width: quadWidth(q), height: quadHeight(q) });

/** 읽는 순서(위→아래, 같은 줄이면 왼→오)로 정렬. 줄 묶음 허용치는 상자 높이로 잡는다. */
export function sortBoxesReadingOrder<T extends { quad: Quad }>(boxes: T[]): T[] {
  if (boxes.length < 2) return [...boxes];
  const mid = (b: T) => ({ y: (b.quad[0].y + b.quad[2].y) / 2, x: Math.min(b.quad[0].x, b.quad[3].x) });
  const heights = boxes.map((b) => quadHeight(b.quad)).sort((a, b) => a - b);
  const tol = Math.max(1, (heights[Math.floor(heights.length / 2)] ?? 1) * 0.6);
  return [...boxes].sort((a, b) => {
    const ma = mid(a);
    const mb = mid(b);
    if (Math.abs(ma.y - mb.y) > tol) return ma.y - mb.y;
    return ma.x - mb.x;
  });
}

// ---------------------------------------------------------------- recognition input

/** PP-OCRv5 인식 모델 입력 높이 */
export const REC_HEIGHT = 48;
/** 학습 시 기준 폭 — 짧은 줄도 이 폭으로 채워 넣는다 */
export const REC_BASE_WIDTH = 320;
export const REC_MAX_WIDTH = 1600;

/**
 * 글자줄 하나를 자를 크기. 가로세로비를 지키고(눌러 담으면 글자가 뭉개진다)
 * 8 의 배수로 맞춘다 — PaddleOCR 도 배치의 최대 비율로 폭을 늘린다.
 */
export function recCropWidth(quad: Quad, height = REC_HEIGHT): number {
  const { width: w, height: h } = boxSize(quad);
  const ratio = h > 0 ? w / h : 1;
  const raw = Math.ceil(height * ratio);
  return Math.min(REC_MAX_WIDTH, Math.max(8, Math.round(raw / 8) * 8));
}

/** 인식 입력 폭 — 자른 폭보다 좁을 수 없고, 짧은 줄은 기준 폭까지 0 으로 채운다. */
export function recPadWidth(cropWidth: number): number {
  return Math.min(REC_MAX_WIDTH, Math.max(REC_BASE_WIDTH, cropWidth));
}

/**
 * 자른 글자줄 RGBA → CHW Float32, (v/255 - 0.5) / 0.5. 남는 오른쪽은 0 으로 채운다
 * (정규화 뒤의 0 = 중간 회색, PaddleOCR 과 같다).
 */
export function normalizeRecInput(img: RgbaImage, padWidth: number): Float32Array {
  const { width: w, height: h, data } = img;
  const pw = Math.max(w, padWidth);
  const out = new Float32Array(3 * h * pw);
  const plane = h * pw;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const p = y * pw + x;
      for (let c = 0; c < 3; c++) out[c * plane + p] = (data[i + c]! / 255 - 0.5) / 0.5;
    }
  return out;
}

// ---------------------------------------------------------------- CTC decoding

/**
 * 사전 파일 → 글자표. PaddleOCR 과 같은 순서로 맞춘다: 0 번은 CTC blank,
 * 마지막은 공백(use_space_char). 줄 끝 개행만 떼고 글자 자체는 건드리지 않는다.
 */
export function buildCharset(dictText: string, useSpaceChar = true): string[] {
  const lines = dictText.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return useSpaceChar ? ["", ...lines, " "] : ["", ...lines];
}

export interface RecResult {
  text: string;
  /** 0..1 — 고른 글자들의 평균 확률 */
  confidence: number;
}

/**
 * CTC greedy 디코딩. 각 시점의 최댓값을 고르고, blank(0)과 직전과 같은 인덱스는 버린다.
 * 모델 출력은 이미 softmax 를 지난 확률이다.
 */
export function decodeCtc(probs: ArrayLike<number>, steps: number, classes: number, charset: string[]): RecResult {
  let text = "";
  let sum = 0;
  let n = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    const base = t * classes;
    let best = 0;
    let bestP = -1;
    for (let c = 0; c < classes; c++) {
      const p = probs[base + c] ?? 0;
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += charset[best] ?? "";
      sum += bestP;
      n++;
    }
    prev = best;
  }
  return { text, confidence: n ? Math.max(0, Math.min(1, sum / n)) : 0 };
}

/** 인식 결과를 버리는 기준 (PaddleOCR drop_score) */
export const REC_DROP_SCORE = 0.5;
