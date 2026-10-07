"use client";
// Shared on-device OCR worker (tesseract.js). Reused across a batch (F-012) so language data loads once.
export interface OcrLineOut {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
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

export async function ocrCanvas(canvas: HTMLCanvasElement, langs = "kor+eng", onProgress?: (p: number, label: string) => void): Promise<OcrLineOut[]> {
  progressCb = onProgress ?? null;
  try {
    onProgress?.(0.15, "인식 엔진 준비 중");
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(canvas, { rotateAuto: true }, { blocks: true, text: true });
    const lines: OcrLineOut[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      const text = l.text.replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
    }
    if (!lines.length && data.text) for (const t of data.text.split("\n")) if (t.trim()) lines.push({ text: t.trim(), confidence: data.confidence });
    onProgress?.(1, "완료");
    return lines;
  } finally {
    progressCb = null;
  }
}

export async function terminateOcr() {
  if (!shared) return;
  const w = shared.worker;
  shared = null;
  await (await w).terminate().catch(() => undefined);
}
