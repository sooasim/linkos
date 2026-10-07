"use client";
// F-010 카메라 촬영(자동 대비/회전 보정), F-011 앞·뒤면, F-015 다국어 OCR — 이미지는 기기 밖으로 나가지 않는다(on-device OCR).
import { useRef, useState } from "react";
import { Icon } from "./Icon";

export interface OcrLineOut {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

async function preprocess(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  const max = 2000;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  // grayscale + percentile contrast stretch (명암 보정)
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]!++;
  }
  const total = w * h;
  let lo = 0;
  let hi = 255;
  for (let acc = 0, i = 0; i < 256; i++) if ((acc += hist[i]!) > total * 0.02) { lo = i; break; }
  for (let acc = 0, i = 255; i >= 0; i--) if ((acc += hist[i]!) > total * 0.02) { hi = i; break; }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i]! - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export const OCR_LANGS = [
  { v: "kor+eng", label: "한국어·영어" },
  { v: "jpn+eng", label: "日本語·English" },
  { v: "chi_sim+eng", label: "中文·English" },
] as const;

export async function runOcr(file: File, onProgress: (p: number, label: string) => void, langs = "kor+eng"): Promise<OcrLineOut[]> {
  onProgress(0.05, "이미지 보정 중");
  const canvas = await preprocess(file);
  const { createWorker } = await import("tesseract.js");
  onProgress(0.15, "인식 엔진 준비 중");
  const worker = await createWorker(langs.split("+"), 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") onProgress(0.35 + m.progress * 0.6, "글자 인식 중");
      else if (m.status.includes("loading")) onProgress(0.15 + m.progress * 0.2, "언어 데이터 불러오는 중");
    },
  });
  try {
    const { data } = await worker.recognize(canvas, { rotateAuto: true }, { blocks: true, text: true });
    const lines: OcrLineOut[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      const text = l.text.replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
    }
    if (!lines.length && data.text) for (const t of data.text.split("\n")) if (t.trim()) lines.push({ text: t.trim(), confidence: data.confidence });
    onProgress(1, "완료");
    return lines;
  } finally {
    await worker.terminate();
  }
}

export function CardScanner({ onLines, onManual, compact = false }: { onLines: (lines: OcrLineOut[], preview: string) => void; onManual?: () => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ p: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<string>("kor+eng");

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    try {
      const lines = await runOcr(file, (p, label) => setProgress({ p, label }), lang);
      if (!lines.length) throw new Error("empty");
      onLines(lines, url);
    } catch {
      setError("글자를 읽지 못했어요. 밝은 곳에서 명함이 화면을 가득 채우도록 다시 촬영하거나 직접 입력하세요.");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="scan-input" aria-label="명함 사진 선택" />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={!!progress}
        className={`group relative grid w-full place-items-center overflow-hidden rounded-[28px] border-2 border-dashed border-[var(--line-strong)] bg-[var(--bg-elev)] ${compact ? "aspect-[2/1]" : "aspect-[1.62/1]"} transition hover:border-[var(--fg)]`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="촬영한 명함" className="absolute inset-0 size-full object-cover opacity-80" />
        ) : null}
        {progress && (
          <div className="absolute inset-0 bg-[var(--color-ink)]/40">
            <div className="absolute inset-x-0 h-0.5 bg-[var(--color-signal)] shadow-[0_0_24px_4px_rgba(200,240,60,.7)]" style={{ top: `${(progress.p * 100) % 100}%`, transition: "top .4s" }} />
          </div>
        )}
        <div className="relative z-10 flex flex-col items-center gap-2 px-6 text-center">
          {progress ? (
            <>
              <span className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-[14px] font-semibold text-white">
                {progress.label} · {Math.round(progress.p * 100)}%
              </span>
            </>
          ) : (
            <>
              <span className="grid size-16 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)] shadow-lg transition group-hover:scale-105">
                <Icon name="camera" size={28} />
              </span>
              <span className={`text-[17px] font-semibold ${preview ? "rounded-full bg-[var(--color-ink)] px-3 py-1 text-white" : ""}`}>{preview ? "다시 촬영" : "종이 명함 촬영"}</span>
              {!preview && <span className="text-[13px] text-[var(--fg-mute)]">사진은 이 기기에서만 분석됩니다</span>}
            </>
          )}
        </div>
      </button>
      <div className="flex justify-center gap-1.5" role="radiogroup" aria-label="명함 언어">
        {OCR_LANGS.map((l) => (
          <button key={l.v} type="button" role="radio" aria-checked={lang === l.v} onClick={() => setLang(l.v)} className={`chip !text-[12px] ${lang === l.v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
            {l.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="rounded-2xl bg-[var(--color-ember)]/10 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
      {onManual && (
        <button type="button" onClick={onManual} className="w-full py-2 text-[14px] font-medium text-[var(--fg-mute)] underline-offset-4 hover:underline">
          직접 입력할게요
        </button>
      )}
    </div>
  );
}
