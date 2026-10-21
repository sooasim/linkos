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
 */
export interface OcrLineOut {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/** capture API 의 `engine` 값으로 그대로 올라간다 (F-187 과금: on-device 는 0원) */
export type OcrEngineId = "tesseract.js" | "ppocrv5-on-device";

export interface OcrResult {
  lines: OcrLineOut[];
  engine: OcrEngineId;
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
      const text = l.text.replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
    }
    if (!lines.length && data.text) for (const t of data.text.split("\n")) if (t.trim()) lines.push({ text: t.trim(), confidence: data.confidence });
    return lines;
  } finally {
    progressCb = null;
  }
}

/**
 * 명함 한 장을 읽는다. `canvas` 는 테두리·원근을 이미 바로잡은(rectified) 이미지다 —
 * 명암 보정은 엔진에 맞춰 안에서 한다.
 */
export async function ocrCanvas(canvas: HTMLCanvasElement, langs = "kor+eng", onProgress?: (p: number, label: string) => void): Promise<OcrResult> {
  try {
    const paddle = await import("./ocrPaddle");
    if (await paddle.paddleModelsAvailable(langs)) {
      const lines = await paddle.ocrCanvasPaddle(canvas, langs, onProgress);
      if (lines.length) {
        onProgress?.(1, "완료");
        return { lines: lines.map((l) => ({ text: l.text, confidence: l.confidence ?? 0, bbox: l.bbox })), engine: "ppocrv5-on-device" };
      }
    }
  } catch {
    // 모델이 깨졌거나 WebGPU/wasm 이 막힌 기기 — 읽기를 포기하지 않고 tesseract 로 간다
  }
  const lines = await ocrTesseract(canvas, langs, onProgress);
  onProgress?.(1, "완료");
  return { lines, engine: "tesseract.js" };
}

export async function terminateOcr() {
  const w = shared?.worker;
  shared = null;
  if (w) await (await w).terminate().catch(() => undefined);
  await import("./ocrPaddle")
    .then((m) => m.terminatePaddle())
    .catch(() => undefined);
}
