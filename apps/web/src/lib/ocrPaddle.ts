"use client";
/*
 * F-015 기기 내 OCR — PP-OCRv5(PaddleOCR) ONNX 엔진.
 *
 * tesseract 는 한국어 명함에서 음절을 흘린다. KBT 2026-10 측정에서 파서의 분류 손실은
 * 사실상 0 이었고(holdout 84.4% / OCR 천장 84.9%) 남은 손실은 전부 '글자를 잘못 읽은'
 * 것이었다. PaddleOCR 의 PP-OCRv5 한국어 인식 모델은 같은 과제에서 공개 지표 88.0% 를
 * 보고한다 — 천장을 올리려면 엔진을 바꿔야 한다.
 *
 * 여기서는 onnxruntime 세션만 다룬다. 전처리·DB 후처리·CTC 디코딩은 @linkos/domain 의
 * 순수 함수(ppocr.ts, 단위테스트 29항목)에 있다. 사진은 기기를 떠나지 않는다 —
 * 받아 오는 것은 모델 파일뿐이다.
 *
 * 모델은 저장소에 담지 않는다(합쳐 30MB). `node scripts/ocr/fetch-models.mjs` 로
 * public/models/ocr/ 에 내려 두면 이 엔진이 켜지고, 없으면 tesseract 로 돌아간다.
 */
import {
  type OcrLine,
  type Quad,
  REC_DROP_SCORE,
  REC_HEIGHT,
  autoContrast,
  buildCharset,
  dbBoxes,
  decodeCtc,
  detResize,
  normalizeDetInput,
  mergeNumberRuns,
  mergeSpacedChars,
  normalizeRecInput,
  recCropQuad,
  recCropWidth,
  recPadWidth,
  sortBoxesReadingOrder,
  warpPerspective,
} from "@linkos/domain";

/** 모델이 놓인 곳. 기본은 자기 도메인의 정적 파일 — 바깥 CDN 을 기본값으로 두지 않는다. */
const MODEL_BASE = process.env.NEXT_PUBLIC_OCR_MODEL_BASE || "/models/ocr/";
/** onnxruntime-web 의 wasm 파일 — fetch-models 스크립트가 같이 복사한다. */
const ORT_BASE = process.env.NEXT_PUBLIC_ORT_BASE || "/ort/";

const DET_MODEL = "ch_PP-OCRv5_det_mobile.onnx";
/**
 * 인식 모델은 글자 집합별로 따로다. PP-OCRv5 의 기본 인식 모델은 중국어·영어·일본어를
 * 함께 다루고, 한국어는 전용 모델이 따로 있다.
 */
const REC_BY_LANG: Record<string, { model: string; dict: string }> = {
  "kor+eng": { model: "korean_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_korean_dict.txt" },
  "jpn+eng": { model: "ch_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_dict.txt" },
  "chi_sim+eng": { model: "ch_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_dict.txt" },
};

const recFor = (langs: string) => REC_BY_LANG[langs] ?? REC_BY_LANG["kor+eng"]!;

type Ort = typeof import("onnxruntime-web");
type Session = import("onnxruntime-web").InferenceSession;

let ortPromise: Promise<Ort> | null = null;
async function loadOrt(): Promise<Ort> {
  ortPromise ??= import("onnxruntime-web").then((m) => {
    m.env.wasm.wasmPaths = ORT_BASE;
    // SharedArrayBuffer 는 COOP/COEP 헤더가 있어야 쓸 수 있다 — 없는 배포에서도 돌게 한 갈래로 둔다
    if (!globalThis.crossOriginIsolated) m.env.wasm.numThreads = 1;
    m.env.logLevel = "error";
    return m;
  });
  return ortPromise;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`model ${r.status}`);
  return r.arrayBuffer();
}

/** 모델 파일이 실제로 올라와 있는가 (언어별로 따로 캐시한다). */
const probes = new Map<string, Promise<boolean>>();
export function paddleModelsAvailable(langs: string): Promise<boolean> {
  const cfg = recFor(langs);
  const key = cfg.model;
  let p = probes.get(key);
  if (!p) {
    p = (async () => {
      try {
        // 끊긴 망에서 영원히 매달리지 않는다 — 못 물어보면 모델이 없는 것으로 보고 tesseract 로 간다
        const heads = await Promise.all(
          [DET_MODEL, cfg.model, cfg.dict].map((f) => fetch(MODEL_BASE + f, { method: "HEAD", cache: "force-cache", signal: AbortSignal.timeout(8000) })),
        );
        return heads.every((r) => r.ok);
      } catch {
        return false;
      }
    })();
    probes.set(key, p);
  }
  return p;
}

const SESSION_OPTS = { executionProviders: ["webgpu", "wasm"], graphOptimizationLevel: "all" } as const;

/** 검출 모델은 언어와 무관하다 — 언어를 바꿔도 한 번만 올린다. */
let detSession: Promise<Session> | null = null;
function loadDet(): Promise<Session> {
  detSession ??= (async () => {
    const ort = await loadOrt();
    return ort.InferenceSession.create(await fetchBuffer(MODEL_BASE + DET_MODEL), SESSION_OPTS);
  })();
  detSession.catch(() => {
    detSession = null;
  });
  return detSession;
}

interface Recognizer {
  rec: Session;
  charset: string[];
}
const recognizers = new Map<string, Promise<Recognizer>>();

function loadRec(langs: string, onProgress?: (p: number, label: string) => void): Promise<Recognizer> {
  const cfg = recFor(langs);
  let p = recognizers.get(cfg.model);
  if (!p) {
    p = (async () => {
      const ort = await loadOrt();
      onProgress?.(0.12, "인식 모델 불러오는 중");
      const [recBuf, dictText] = await Promise.all([
        fetchBuffer(MODEL_BASE + cfg.model),
        fetch(MODEL_BASE + cfg.dict, { cache: "force-cache" }).then((r) => {
          if (!r.ok) throw new Error(`dict ${r.status}`);
          return r.text();
        }),
      ]);
      return { rec: await ort.InferenceSession.create(recBuf, SESSION_OPTS), charset: buildCharset(dictText) };
    })();
    recognizers.set(cfg.model, p);
    p.catch(() => recognizers.delete(cfg.model));
  }
  return p;
}

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext("2d", { willReadFrequently: true })!;
}

/** 검출 입력 크기로 줄여 그린 복사본 */
function resized(src: HTMLCanvasElement, width: number, height: number): ImageData {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = ctx2d(c);
  g.drawImage(src, 0, 0, width, height);
  return g.getImageData(0, 0, width, height);
}

const quadBBox = (q: Quad) => {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/**
 * 명함 한 장 → 글자줄 목록. 좌표는 입력 캔버스 기준이라 파서가 글씨 크기를 그대로 쓸 수 있다
 * (DB 검출 상자는 tesseract 의 줄 상자보다 글자에 딱 붙는다).
 */
export async function ocrCanvasPaddle(canvas: HTMLCanvasElement, langs = "kor+eng", onProgress?: (p: number, label: string) => void): Promise<OcrLine[]> {
  const ort = await loadOrt();
  const [det, { rec, charset }] = await Promise.all([loadDet(), loadRec(langs, onProgress)]);
  onProgress?.(0.35, "글자 위치 찾는 중");

  const size = detResize(canvas.width, canvas.height);
  const img = resized(canvas, size.width, size.height);
  // 검은 명함에 흰 글씨처럼 밝기 폭이 좁은 사진만 늘린다(넓으면 그대로 둔다)
  const { data: detPixels } = autoContrast({ width: size.width, height: size.height, data: img.data });
  const detIn = new ort.Tensor("float32", normalizeDetInput({ width: size.width, height: size.height, data: detPixels }), [1, 3, size.height, size.width]);
  /*
   * 검출은 한 번의 긴 호출이라 그 사이 진행률이 멈춘다. 35% 에 붙어 있으면 사람은
   * 고장으로 읽는다. 돌고 있다는 것만 보이게 조금씩 올린다(실제 진척도는 알 수 없다).
   */
  let faux = 0.35;
  const tick = setInterval(() => onProgress?.((faux = Math.min(0.48, faux + 0.01)), "글자 위치 찾는 중"), 250);
  let detOut: Awaited<ReturnType<typeof det.run>>;
  try {
    detOut = await det.run({ [det.inputNames[0]!]: detIn });
  } finally {
    clearInterval(tick);
  }
  const probTensor = detOut[det.outputNames[0]!]!;
  const dims = probTensor.dims;
  const pw = Number(dims[dims.length - 1]);
  const ph = Number(dims[dims.length - 2]);
  const prob = probTensor.data as Float32Array;
  const boxes = sortBoxesReadingOrder(dbBoxes(prob, pw, ph, { ratioX: canvas.width / pw, ratioY: canvas.height / ph }));
  if (!boxes.length) return [];

  onProgress?.(0.5, "글자 인식 중");
  const full = ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  const src = { width: canvas.width, height: canvas.height, data: full.data, channels: 4 };
  const lines: OcrLine[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    const quad = recCropQuad(box.quad);
    const cropW = recCropWidth(quad);
    const padW = recPadWidth(cropW);
    const crop = warpPerspective(src, quad, cropW, REC_HEIGHT);
    const recIn = new ort.Tensor("float32", normalizeRecInput({ width: cropW, height: REC_HEIGHT, data: crop }, padW), [1, 3, REC_HEIGHT, padW]);
    const recOut = await rec.run({ [rec.inputNames[0]!]: recIn });
    const logits = recOut[rec.outputNames[0]!]!;
    const steps = Number(logits.dims[1]);
    const classes = Number(logits.dims[2]);
    const { text, confidence } = decodeCtc(logits.data as Float32Array, steps, classes, charset);
    const trimmed = text.trim();
    // 검출 확신과 인식 확신을 함께 본다 — 파서의 '확인 필요' 기준이 이 값이다
    if (trimmed && confidence >= REC_DROP_SCORE) lines.push({ text: trimmed, confidence: confidence * box.score, bbox: quadBBox(box.quad) });
    onProgress?.(0.5 + (0.45 * (i + 1)) / boxes.length, "글자 인식 중");
  }
  // 자간 넓게 찍어 토막으로 잡힌 것을 잇는다 — 번호("010 5598 4392")와 이름("최 원 석")
  return mergeNumberRuns(mergeSpacedChars(lines));
}

/** 쓰고 난 세션을 놓는다 (배치 스캔이 끝났을 때). */
export async function terminatePaddle() {
  const open = [...recognizers.values()];
  const d = detSession;
  recognizers.clear();
  detSession = null;
  for (const p of open) await (await p.catch(() => null))?.rec.release().catch(() => undefined);
  if (d) await (await d.catch(() => null))?.release().catch(() => undefined);
}
