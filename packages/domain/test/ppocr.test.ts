// F-015: PP-OCRv5 파이프라인의 순수 계산부 — 전처리·DB 후처리·CTC 디코딩.
// 모델 없이 고정할 수 있는 부분을 전부 여기서 잠근다(모델 실행은 apps/web 어댑터).
import { describe, expect, it } from "vitest";
import {
  DET_MEAN,
  DET_STD,
  type Quad,
  REC_BASE_WIDTH,
  REC_HEIGHT,
  autoContrast,
  boxScore,
  buildCharset,
  dbBoxes,
  decodeCtc,
  detResize,
  mergeNumberRuns,
  minAreaRect,
  normalizeDetInput,
  normalizeRecInput,
  pointInQuad,
  recCropQuad,
  recCropWidth,
  recPadWidth,
  sortBoxesReadingOrder,
  unclipRect,
} from "../src";

const rect = (x0: number, y0: number, x1: number, y1: number): Quad => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe("detResize — 검출 입력 크기 (PaddleOCR limit_type/limit_side_len)", () => {
  it("짧은 변을 limit 까지 키우고 32 의 배수로 맞춘다", () => {
    const r = detResize(1000, 600);
    expect(r.height % 32).toBe(0);
    expect(r.width % 32).toBe(0);
    expect(r.height).toBeGreaterThanOrEqual(736 - 16);
    // 되돌리기 비율은 원본/입력
    expect(r.width * r.ratioX).toBeCloseTo(1000, 6);
    expect(r.height * r.ratioY).toBeCloseTo(600, 6);
  });

  it("짧은 변이 이미 충분하면 키우지 않는다", () => {
    const r = detResize(1600, 1000);
    expect(r.width).toBe(1600);
    expect(r.height).toBe(992); // 1000 → 32 의 배수
  });

  it("limit_type=max 는 긴 변을 줄인다", () => {
    const r = detResize(3000, 1000, { limitType: "max", limitSideLen: 960 });
    expect(r.width).toBe(960);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(960);
  });

  it("긴 변이 maxSide 를 넘지 않는다", () => {
    const r = detResize(20000, 100, { maxSide: 1024 });
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1024);
  });

  it("아주 작은 입력도 최소 32 를 지킨다", () => {
    const r = detResize(1, 1);
    expect(r.width).toBeGreaterThanOrEqual(32);
    expect(r.height).toBeGreaterThanOrEqual(32);
  });
});

describe("normalizeDetInput / normalizeRecInput", () => {
  it("det 입력은 CHW 이고 ImageNet 평균·표준편차를 쓴다", () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]); // 빨강, 초록
    const t = normalizeDetInput({ width: 2, height: 1, data });
    expect(t.length).toBe(3 * 2);
    expect(t[0]).toBeCloseTo((1 - DET_MEAN[0]) / DET_STD[0], 6); // R 평면 첫 화소
    expect(t[1]).toBeCloseTo((0 - DET_MEAN[0]) / DET_STD[0], 6);
    expect(t[2]).toBeCloseTo((0 - DET_MEAN[1]) / DET_STD[1], 6); // G 평면 첫 화소
    expect(t[3]).toBeCloseTo((1 - DET_MEAN[1]) / DET_STD[1], 6);
  });

  it("rec 입력은 (v/255-0.5)/0.5 이고 남는 폭은 0 으로 채운다", () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]); // 흰, 검정
    const t = normalizeRecInput({ width: 2, height: 1, data }, 4);
    expect(t.length).toBe(3 * 1 * 4);
    expect(t[0]).toBeCloseTo(1, 6);
    expect(t[1]).toBeCloseTo(-1, 6);
    expect(t[2]).toBe(0); // 채운 자리
    expect(t[3]).toBe(0);
  });

  it("padWidth 가 자른 폭보다 좁으면 자른 폭을 쓴다 (잘라 버리지 않는다)", () => {
    const data = new Uint8ClampedArray(4 * 3);
    const t = normalizeRecInput({ width: 3, height: 1, data }, 1);
    expect(t.length).toBe(3 * 1 * 3);
  });
});

describe("minAreaRect — 최소면적 외접 직사각형", () => {
  it("축에 나란한 사각형은 그대로 돌려준다", () => {
    const r = minAreaRect(rect(10, 20, 50, 40));
    expect(r).not.toBeNull();
    const size = [r!.width, r!.height].sort((a, b) => a - b);
    expect(size[0]).toBeCloseTo(20, 6);
    expect(size[1]).toBeCloseTo(40, 6);
    expect(r!.center.x).toBeCloseTo(30, 6);
    expect(r!.center.y).toBeCloseTo(30, 6);
  });

  it("45° 돌아간 정사각형은 한 변 길이를 찾아낸다 (축정렬 bbox 보다 작다)", () => {
    const s = 10;
    const r = minAreaRect([
      { x: 0, y: -s },
      { x: s, y: 0 },
      { x: 0, y: s },
      { x: -s, y: 0 },
    ]);
    const side = s * Math.SQRT2;
    expect(r!.width).toBeCloseTo(side, 4);
    expect(r!.height).toBeCloseTo(side, 4);
  });

  it("점이 모자라면 null", () => {
    expect(minAreaRect([{ x: 1, y: 1 }])).toBeNull();
  });
});

describe("unclipRect — 획만 남은 상자를 글자 크기로 넓힌다", () => {
  it("거리는 면적×비율/둘레 (PaddleOCR unclip)", () => {
    const r = minAreaRect(rect(0, 0, 20, 10))!;
    const q = unclipRect(r, 1.5);
    // area 200, perimeter 60 → d = 200*1.5/60 = 5
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-5, 4);
    expect(Math.max(...xs)).toBeCloseTo(25, 4);
    expect(Math.min(...ys)).toBeCloseTo(-5, 4);
    expect(Math.max(...ys)).toBeCloseTo(15, 4);
  });
});

describe("pointInQuad / boxScore", () => {
  it("내부·경계는 참, 외부는 거짓", () => {
    const q = rect(0, 0, 10, 10);
    expect(pointInQuad(q, { x: 5, y: 5 })).toBe(true);
    expect(pointInQuad(q, { x: 0, y: 5 })).toBe(true);
    expect(pointInQuad(q, { x: -1, y: 5 })).toBe(false);
    expect(pointInQuad(q, { x: 11, y: 11 })).toBe(false);
  });

  it("상자 안 확률의 평균을 돌려준다", () => {
    const w = 20;
    const h = 20;
    const prob = new Float32Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) prob[y * w + x] = 0.8;
    expect(boxScore(prob, w, h, rect(5, 5, 15, 15))).toBeCloseTo(0.8, 2);
    expect(boxScore(prob, w, h, rect(0, 0, 4, 4))).toBeCloseTo(0, 6);
  });
});

describe("dbBoxes — 확률맵에서 글자줄 상자 뽑기", () => {
  const W = 80;
  const H = 80;
  const prob = new Float32Array(W * H);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * W + x] = v;
  };
  fill(10, 10, 60, 20, 0.95); // 윗줄
  fill(10, 40, 35, 50, 0.9); // 아랫줄
  fill(70, 70, 72, 72, 0.95); // 찌꺼기 (2×2)

  it("글자줄만 상자가 되고 찌꺼기는 버려진다", () => {
    const boxes = dbBoxes(prob, W, H);
    expect(boxes.length).toBe(2);
    for (const b of boxes) expect(b.score).toBeGreaterThan(0.6);
  });

  it("상자는 원래 blob 보다 넓다 (unclip)", () => {
    const [top] = dbBoxes(prob, W, H);
    const xs = top!.quad.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(10);
    expect(Math.max(...xs)).toBeGreaterThan(60);
  });

  it("평균 확률이 낮은 덩어리는 box_thresh 에서 걸린다", () => {
    const faint = new Float32Array(W * H);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 60; x++) faint[y * W + x] = 0.35;
    expect(dbBoxes(faint, W, H).length).toBe(0);
    expect(dbBoxes(faint, W, H, undefined, { boxThresh: 0.3 }).length).toBe(1);
  });

  it("비율을 주면 원본 좌표로 되돌린다", () => {
    const [a] = dbBoxes(prob, W, H);
    const [b] = dbBoxes(prob, W, H, { ratioX: 2, ratioY: 3 });
    expect(b!.quad[0].x).toBeCloseTo(a!.quad[0].x * 2, 4);
    expect(b!.quad[0].y).toBeCloseTo(a!.quad[0].y * 3, 4);
  });

  it("빈 확률맵은 빈 결과", () => {
    expect(dbBoxes(new Float32Array(W * H), W, H)).toEqual([]);
  });
});

describe("sortBoxesReadingOrder", () => {
  it("위→아래, 같은 줄이면 왼→오", () => {
    const boxes = [
      { quad: rect(100, 50, 180, 70), id: "b" },
      { quad: rect(10, 200, 90, 220), id: "c" },
      { quad: rect(10, 50, 90, 70), id: "a" },
    ];
    expect(sortBoxesReadingOrder(boxes).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("상자가 하나뿐이면 그대로", () => {
    const one = [{ quad: rect(0, 0, 1, 1) }];
    expect(sortBoxesReadingOrder(one)).toHaveLength(1);
  });
});

describe("recCropWidth / recPadWidth — 인식 입력 폭", () => {
  it("가로세로비를 지키고 8 의 배수로 맞춘다", () => {
    const w = recCropWidth(rect(0, 0, 200, 50));
    expect(w % 8).toBe(0);
    expect(w).toBeCloseTo(Math.round((REC_HEIGHT * 4) / 8) * 8, 0);
  });

  it("짧은 줄은 기준 폭까지 채우고, 긴 줄은 자른 폭을 쓴다", () => {
    expect(recPadWidth(100)).toBe(REC_BASE_WIDTH);
    expect(recPadWidth(600)).toBe(600);
  });

  it("아주 긴 줄도 상한을 넘지 않는다", () => {
    expect(recCropWidth(rect(0, 0, 10000, 10))).toBeLessThanOrEqual(1600);
  });
});

describe("autoContrast — 명암이 좁은 사진만 늘린다", () => {
  const gray = (v: number, n = 64) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = i < n / 2 ? v : v + 20;
      d[i * 4 + 3] = 255;
    }
    return { width: n, height: 1, data: d };
  };

  it("폭이 좁으면 0–255 로 늘린다", () => {
    const r = autoContrast(gray(30));
    expect(r.applied).toBe(true);
    const lo = r.data[0]!;
    const hi = r.data[(63 * 4) as number]!;
    expect(hi - lo).toBeGreaterThan(200);
  });

  it("이미 넓으면 손대지 않는다", () => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) {
      const v = i < 32 ? 5 : 250;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    const r = autoContrast({ width: 64, height: 1, data: d });
    expect(r.applied).toBe(false);
    expect([...r.data]).toEqual([...d]);
  });

  it("단색이면 그대로 둔다 (0 으로 나누지 않는다)", () => {
    const flat = new Uint8ClampedArray(16 * 4).fill(120);
    const r = autoContrast({ width: 16, height: 1, data: flat });
    expect(r.applied).toBe(false);
  });
});

describe("recCropQuad — 세로로 긴 상자는 돌려 자른다", () => {
  it("가로 줄은 그대로", () => {
    const q = rect(0, 0, 200, 50);
    expect(recCropQuad(q)).toEqual(q);
  });

  it("세로 줄은 꼭짓점 차례를 한 칸 민다", () => {
    const q = rect(0, 0, 50, 200);
    expect(recCropQuad(q)).toEqual([q[1], q[2], q[3], q[0]]);
  });
});

describe("mergeNumberRuns — 여러 줄로 쪼개 인쇄한 번호", () => {
  const line = (text: string, y: number) => ({ text, confidence: 0.9, bbox: { x0: 10, y0: y, x1: 200, y1: y + 60 } });

  it("010 / 5598 / 4392 를 한 줄로 잇는다", () => {
    const out = mergeNumberRuns([line("BNI", 0), line("010", 100), line("5598", 200), line("4392", 300), line("변진수", 400)]);
    expect(out.map((l) => l.text)).toEqual(["BNI", "010 5598 4392", "변진수"]);
    expect(out[1]!.bbox).toEqual({ x0: 10, y0: 100, x1: 200, y1: 360 });
  });

  it("합쳐서 번호 길이가 아니면 잇지 않는다", () => {
    expect(mergeNumberRuns([line("2024", 0), line("2025", 100)]).map((l) => l.text)).toEqual(["2024", "2025"]);
  });

  it("0 으로 시작하지 않으면 잇지 않는다", () => {
    expect(mergeNumberRuns([line("1588", 0), line("1234", 100), line("5678", 200)]).map((l) => l.text)).toEqual(["1588", "1234", "5678"]);
  });

  it("이미 한 줄인 번호는 건드리지 않는다", () => {
    expect(mergeNumberRuns([line("010-5598-4392", 0)]).map((l) => l.text)).toEqual(["010-5598-4392"]);
  });

  it("빈 입력", () => {
    expect(mergeNumberRuns([])).toEqual([]);
  });
});

describe("buildCharset / decodeCtc", () => {
  const charset = buildCharset("가\n나\n다\n");

  it("0 번은 blank, 마지막은 공백", () => {
    expect(charset[0]).toBe("");
    expect(charset[1]).toBe("가");
    expect(charset[charset.length - 1]).toBe(" ");
    expect(charset).toHaveLength(5); // blank + 3 + space
  });

  it("use_space_char=false 면 공백을 붙이지 않는다", () => {
    expect(buildCharset("가\n나", false)).toEqual(["", "가", "나"]);
  });

  const step = (...p: number[]) => p;
  it("blank 와 이어진 중복을 걸러 낸다", () => {
    // 가, 가(중복), blank, 가, 나
    const probs = new Float32Array([
      ...step(0.1, 0.9, 0, 0, 0),
      ...step(0.1, 0.8, 0, 0, 0),
      ...step(0.95, 0.05, 0, 0, 0),
      ...step(0.2, 0.7, 0, 0, 0),
      ...step(0.1, 0, 0.9, 0, 0),
    ]);
    const r = decodeCtc(probs, 5, 5, charset);
    expect(r.text).toBe("가가나");
    expect(r.confidence).toBeCloseTo((0.9 + 0.7 + 0.9) / 3, 6);
  });

  it("전부 blank 면 빈 문자열, 확신 0", () => {
    const probs = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(decodeCtc(probs, 2, 5, charset)).toEqual({ text: "", confidence: 0 });
  });

  it("사전에 없는 인덱스는 글자를 지어내지 않는다", () => {
    const probs = new Float32Array([0, 0, 0, 0, 0, 0.9]); // classes=6, 사전은 5개
    const r = decodeCtc(probs, 1, 6, charset);
    expect(r.text).toBe("");
  });
});
