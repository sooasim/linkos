"use client";
/*
 * F-012/F-015 기기 내 OCR — 엔진을 고르는 곳.
 *
 *   ① PP-OCRv5(PaddleOCR, ONNX)  — 모델 파일이 올라와 있으면 이쪽. 한국어 명함에서
 *      tesseract 보다 글자를 훨씬 잘 읽는다(공개 지표 88.0%).
 *   ② tesseract.js               — 늘 되는 갈래. 모델이 없거나 ①이 실패하면 이쪽.
 *
 * 두 엔진 모두 사진을 기기 밖으로 보내지 않는다. 엔진마다 좋아하는 입력이 달라서
 * 전처리도 여기서 갈라 준다 — tesseract 는 명암을 늘린 회색 이미지를, PP-OCR 은
 * 자연 사진 그대로를 전제로 학습돼 있다.
 *
 * tesseract 가 뱉은 줄은 파서에 넘기기 전에 tidyOcrText 로 치운다(#14 통일) — 모든 스캔
 * 경로가 이 곳을 지나므로 찌꺼기(글자별 공백·인쇄선 막대·메일 쉼표)가 어느 화면에서나 같게 정리된다.
 */
import { tidyOcrText } from "@linkos/domain";
export interface OcrLineOut {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * capture API 의 `engine` 값으로 그대로 올라간다 (F-187 과금: on-device 는 0원,
 * `vision:…` 은 서버 1장 요율). 어떤 엔진이 읽었는지는 나중에 되짚을 수 있어야 한다.
 */
export type OcrEngineId = "tesseract.js" | "ppocrv5-on-device" | `vision:${string}`;

export interface OcrResult {
  lines: OcrLineOut[];
  engine: OcrEngineId;
}

/** 기기 내 인식을 할 수 없을 때 던진다 (`code` 로 가려낸다 — 동적 import 라 instanceof 를 쓰지 않는다) */
export interface OcrUnavailable extends Error {
  code: "wasm_blocked";
}

/**
 * 두 엔진 모두 WebAssembly 로 돈다. 응답 헤더의 CSP `script-src` 에 `'wasm-unsafe-eval'` 이
 * 없으면 `WebAssembly.compile` 이 던지고, 그러면 tesseract 도 PP-OCR 도 쓸 수 없다.
 *
 * 이걸 미리 보지 않으면 진행률이 35%("언어 데이터 불러오는 중" 끝 = "글자 위치 찾는 중" 시작)에서
 * 영구히 멈춘 것처럼 보인다 — 실제로 nginx 가 공용 CSP 를 하나 더 붙여 그렇게 됐다.
 * 여기서 8바이트짜리 빈 모듈을 컴파일해 보고, 막혀 있으면 바로 사람에게 알린다.
 */
let wasmProbe: Promise<boolean> | null = null;
export function wasmUsable(): Promise<boolean> {
  wasmProbe ??= (async () => {
    try {
      if (typeof WebAssembly?.compile !== "function") return false;
      await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      return true;
    } catch {
      return false;
    }
  })();
  return wasmProbe;
}

/**
 * 멈춘 엔진을 기다리지 않는다. 밑에서 돌던 일을 취소할 수는 없지만(wasm 호출은 중간에
 * 끊을 수 없다) 다음 갈래로 넘어갈 수는 있다. PP-OCR 은 첫 실행에 모델 33MB 를 받으므로
 * 넉넉히 준다 — 받는 동안은 진행률이 움직이니 사람이 기다릴 수 있다.
 */
const PADDLE_BUDGET_MS = 90_000;
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type Worker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;
let shared: { langs: string; worker: Promise<Worker> } | null = null;
let progressCb: ((p: number, label: string) => void) | null = null;

async function getWorker(langs: string): Promise<Worker> {
  if (shared && shared.langs === langs) return shared.worker;
  if (shared) await (await shared.worker).terminate().catch(() => undefined);
  const { createWorker } = await import("tesseract.js");
  const worker = createWorker(langs.split("+"), 1, {
    logger: (m: { status: string; progress: number }) => {
      if (!progressCb) return;
      if (m.status === "recognizing text") progressCb(0.35 + m.progress * 0.6, "글자 인식 중");
      else if (m.status.includes("loading")) progressCb(0.15 + m.progress * 0.2, "언어 데이터 불러오는 중");
    },
  });
  shared = { langs, worker };
  worker.catch(() => {
    shared = null;
  });
  return worker;
}

async function ocrTesseract(canvas: HTMLCanvasElement, langs: string, onProgress?: (p: number, label: string) => void): Promise<OcrLineOut[]> {
  progressCb = onProgress ?? null;
  try {
    onProgress?.(0.15, "인식 엔진 준비 중");
    const worker = await getWorker(langs);
    const { enhanceForOcr } = await import("./imagePipeline");
    const { data } = await worker.recognize(enhanceForOcr(canvas), { rotateAuto: true }, { blocks: true, text: true });
    const lines: OcrLineOut[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      const text = tidyOcrText(l.text);
      if (text) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
    }
    if (!lines.length && data.text) for (const t of data.text.split("\n")) { const text = tidyOcrText(t); if (text) lines.push({ text, confidence: data.confidence }); }
    onProgress?.(1, "완료");
    return lines;
  } finally {
    progressCb = null;
  }
}

/**
 * 원근 보정이 빗나갔다고 볼 수 있는 줄 수. 명함은 이름·회사·연락처만 해도 이보다 많다.
 *
 * 테두리 검출은 자신 있게 틀릴 때가 있다 — 측정 묶음의 검은 명함에서 반사광 경계를
 * 카드로 잡아(confidence 0.98) 글자가 한쪽에 눌린 채 잘렸고, 글자줄이 하나도 안 나왔다.
 * 같은 사진을 원본 그대로 읽으면 일곱 줄이 전부 나온다. 그래서 빈약하면 다시 읽는다.
 */
const MIN_LINES = 4;

/**
 * 명함 한 장을 읽는다. `canvas` 는 테두리·원근을 이미 바로잡은(rectified) 이미지다 —
 * 명암 보정은 엔진에 맞춰 안에서 한다. `fallback` 을 주면(보정 전 원본) 보정본에서
 * 글자가 거의 안 나왔을 때 그걸로 한 번 더 읽고 더 많이 읽힌 쪽을 쓴다.
 */
export async function ocrCanvas(
  canvas: HTMLCanvasElement,
  langs = "kor+eng",
  onProgress?: (p: number, label: string) => void,
  fallback?: HTMLCanvasElement | null,
): Promise<OcrResult> {
  const first = await ocrOnce(canvas, langs, onProgress);
  if (first.lines.length >= MIN_LINES || !fallback || fallback === canvas) return first;
  const second = await ocrOnce(fallback, langs, onProgress).catch(() => null);
  return second && second.lines.length > first.lines.length ? second : first;
}

/**
 * 엔진이 뱉은 줄을 손질한다 — **어떤 엔진을 써도 같은 손질을 거친다.**
 * 자간 넓게 찍어 토막으로 잡힌 이름("최 원 석")과, 여러 줄로 쪼개 인쇄한 번호
 * ("010 / 5598 / 4392")를 잇는다. 상자 좌표가 없는 엔진에서는 이름 잇기가 그냥 지나간다.
 */
export async function tidyLines(lines: OcrLineOut[]): Promise<OcrLineOut[]> {
  const { mergeNumberRuns, mergeSpacedChars } = await import("@linkos/domain");
  /*
   * 120 줄로 자른다 — /capture/cards 의 captureInput 스키마가 `lines.max(120)` 이라,
   * 시끄러운 사진에서 검출이 수백 상자를 뱉으면(dbBoxes maxCandidates 1000) 그대로 보냈다가
   * 400 validation_failed 로 스캔 한 장이 통째로 버려졌다. 서버 어댑터(cleanVisionOcrLines)·
   * 게스트 경로와 같은 상한이다. 명함 한 장의 글자줄은 이보다 적다 — 넘치면 찌꺼기다.
   */
  return mergeNumberRuns(mergeSpacedChars(lines))
    .slice(0, 120)
    .map((l) => ({ text: l.text, confidence: l.confidence ?? 0, bbox: l.bbox }));
}

async function ocrOnce(canvas: HTMLCanvasElement, langs: string, onProgress?: (p: number, label: string) => void): Promise<OcrResult> {
  if (!(await wasmUsable())) {
    const e = new Error("WebAssembly is blocked — CSP script-src is missing 'wasm-unsafe-eval'") as OcrUnavailable;
    e.code = "wasm_blocked";
    throw e;
  }
  try {
    const paddle = await import("./ocrPaddle");
    if (await paddle.paddleModelsAvailable(langs)) {
      const lines = await withTimeout(paddle.ocrCanvasPaddle(canvas, langs, onProgress), PADDLE_BUDGET_MS, "PP-OCRv5");
      if (lines.length) {
        onProgress?.(1, "완료");
        return { lines: await tidyLines(lines.map((l) => ({ text: l.text, confidence: l.confidence ?? 0, bbox: l.bbox }))), engine: "ppocrv5-on-device" };
      }
    }
  } catch {
    // 모델이 깨졌거나 WebGPU/wasm 이 막힌 기기 — 읽기를 포기하지 않고 tesseract 로 간다
  }
  const lines = await ocrTesseract(canvas, langs, onProgress);
  onProgress?.(1, "완료");
  return { lines: await tidyLines(lines), engine: "tesseract.js" };
}

// ---------------------------------------------------------------- 한 장 읽기 (모든 화면이 쓰는 길)

export interface CardRead {
  lines: OcrLineOut[];
  engine: OcrEngineId;
  /** 테두리·원근을 바로잡은 이미지 (원본 보관을 켠 경우에만 올라간다) */
  jpeg: Blob;
  /** 검토 화면에 띄우는 작은 그림 */
  thumb: string;
  corrected: boolean;
  /** 테두리 검출 확신 (못 찾았으면 null) */
  detectionConfidence: number | null;
}

export interface ReadOptions {
  langs?: string;
  /** 테두리·원근 보정을 할 것인가 (사용자가 끌 수 있다) */
  autoCorrect?: boolean;
  onProgress?: (p: number, label: string) => void;
  /** 진행률 문구 (화면 언어에 맞춰 넘긴다) */
  labels?: { findingEdges: string; perspectiveDone: string; enhancing: string };
}

/**
 * 사진 한 장 → 글자줄. **촬영·사진첩 가져오기·게스트 링크·배지가 모두 이 길을 쓴다.**
 *
 * 예전에는 같은 절차가 CardScanner 와 BatchImport 에 따로 적혀 있어서, 한쪽만 고치면
 * 같은 명함이 화면마다 다르게 읽혔다(원본 재시도 폴백이 한동안 촬영 화면에만 있었다).
 * 인식을 좋게 하는 일은 전부 여기 한 곳에서 한다.
 */
export async function readCardImage(file: Blob, opts: ReadOptions = {}): Promise<CardRead> {
  const t = opts.labels;
  opts.onProgress?.(0.03, t?.findingEdges ?? "");
  const pipe = await import("./imagePipeline");
  const base = await pipe.loadCanvas(file);
  const fixed = opts.autoCorrect === false ? { canvas: base, detection: null } : pipe.autoCorrect(base);
  opts.onProgress?.(0.1, (fixed.detection ? t?.perspectiveDone : t?.enhancing) ?? "");
  return finish(pipe, base, fixed.canvas, fixed.detection?.confidence ?? null, !!fixed.detection, opts);
}

/**
 * F-013 한 장에 여러 명함 — 명함마다 한 번씩 읽는다. 조각 하나가 곧 한 장이므로
 * 원본 재시도는 하지 않는다(원본에는 다른 명함들이 함께 들어 있다).
 */
export async function readCardImages(file: Blob, opts: ReadOptions & { split?: boolean } = {}): Promise<CardRead[]> {
  if (!opts.split) return [await readCardImage(file, opts)];
  const pipe = await import("./imagePipeline");
  const base = await pipe.loadCanvas(file);
  const { canvases } = pipe.splitCards(base);
  if (canvases.length <= 1) return [await finish(pipe, base, canvases[0] ?? base, null, canvases[0] !== base, opts)];
  const out: CardRead[] = [];
  for (const c of canvases) out.push(await finish(pipe, c, c, null, true, opts));
  return out;
}

/** 서버 OCR 어댑터가 멈춰 있어도 스캔이 멈추지 않게 하는 상한 */
const SERVER_BUDGET_MS = 25_000;

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * F-015 서버 OCR 어댑터. 기기 내 엔진이 못 읽는 명함(흐린 인쇄·로고꼴 이름·세로 배치)을
 * 위해 둔 갈래다. 서버가 키 없이 돌고 있으면 빈 목록을 주므로 자연히 기기 내로 돌아간다 —
 * 켜고 끄는 것은 서버 환경( `ANTHROPIC_API_KEY` · `LLM_DISABLED` )이 정한다.
 */
async function ocrServer(jpeg: Blob, onProgress?: (p: number, label: string) => void): Promise<OcrResult | null> {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    onProgress?.(0.2, "글자 인식 중");
    const res = await fetch("/api/v1/capture/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      signal: AbortSignal.timeout(SERVER_BUDGET_MS),
      body: JSON.stringify({ mime: "image/jpeg", image: toBase64(await jpeg.arrayBuffer()) }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { lines?: { text: string; confidence?: number }[]; engine?: string };
    if (!j.lines?.length || !j.engine) return null;
    return { lines: j.lines.map((l) => ({ text: l.text, confidence: l.confidence ?? 0.9 })), engine: j.engine as OcrEngineId };
  } catch {
    return null; // 오프라인·시간초과·서버 꺼짐 — 기기 내 엔진으로 간다
  }
}

async function finish(
  pipe: typeof import("./imagePipeline"),
  fallback: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  detectionConfidence: number | null,
  corrected: boolean,
  opts: ReadOptions,
): Promise<CardRead> {
  const jpeg = await pipe.canvasToJpeg(canvas);
  const thumb = pipe.thumbnail(canvas);
  // ① 서버 어댑터(가장 잘 읽는다) → ② 기기 내 PP-OCRv5 → ③ tesseract
  const server = await ocrServer(jpeg, opts.onProgress);
  if (server) {
    opts.onProgress?.(1, "완료");
    return { lines: await tidyLines(server.lines), engine: server.engine, jpeg, thumb, corrected, detectionConfidence };
  }
  const { lines, engine } = await ocrCanvas(canvas, opts.langs ?? "kor+eng", opts.onProgress, corrected && canvas !== fallback ? fallback : null);
  return { lines, engine, jpeg, thumb, corrected, detectionConfidence };
}

export async function terminateOcr() {
  const w = shared?.worker;
  shared = null;
  if (w) await (await w).terminate().catch(() => undefined);
  await import("./ocrPaddle")
    .then((m) => m.terminatePaddle())
    .catch(() => undefined);
}
