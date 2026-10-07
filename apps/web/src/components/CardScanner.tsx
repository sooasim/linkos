"use client";
// F-010 카메라 촬영 — 자동 테두리 검출·크롭·원근/회전 보정(homography warp) + 명암 보정 후 OCR,
// F-011 앞·뒤면, F-014 배지, F-015 다국어 OCR. 이미지는 기기 안에서 처리된다(on-device OCR);
// 원본 보관(F-019)은 사용자가 명시적으로 켠 경우에만 상위 화면이 업로드한다.
import { useRef, useState } from "react";
import type { OcrLineOut } from "@/lib/ocr";
import { Icon } from "./Icon";

export type { OcrLineOut } from "@/lib/ocr";

export const OCR_LANGS = [
  { v: "kor+eng", label: "한국어·영어" },
  { v: "jpn+eng", label: "日本語·English" },
  { v: "chi_sim+eng", label: "中文·English" },
] as const;

export interface ScanExtra {
  /** the rectified (cropped/deskewed) image as JPEG — stays on device unless the user opts in to keep it */
  jpeg: Blob;
  corrected: boolean;
  confidence: number | null;
}

/** Pipeline: EXIF-orient → detect card quad → perspective warp → contrast stretch → OCR. */
export async function runOcr(file: Blob, onProgress: (p: number, label: string) => void, langs = "kor+eng", opts: { autoCorrect?: boolean } = {}): Promise<{ lines: OcrLineOut[]; extra: ScanExtra; preview: string }> {
  onProgress(0.03, "테두리 찾는 중");
  const pipe = await import("@/lib/imagePipeline");
  const { ocrCanvas } = await import("@/lib/ocr");
  const base = await pipe.loadCanvas(file);
  const fixed = opts.autoCorrect === false ? { canvas: base, detection: null } : pipe.autoCorrect(base);
  onProgress(0.1, fixed.detection ? "원근 보정 완료" : "이미지 보정 중");
  const jpeg = await pipe.canvasToJpeg(fixed.canvas);
  const lines = await ocrCanvas(pipe.enhanceForOcr(fixed.canvas), langs, onProgress);
  return { lines, preview: URL.createObjectURL(jpeg), extra: { jpeg, corrected: !!fixed.detection, confidence: fixed.detection?.confidence ?? null } };
}

export function CardScanner({
  onLines,
  onManual,
  onOfflinePhoto,
  compact = false,
  kind = "card",
}: {
  onLines: (lines: OcrLineOut[], preview: string, extra?: ScanExtra) => void;
  onManual?: () => void;
  /** called with the photo when on-device OCR cannot run offline (language data not cached) */
  onOfflinePhoto?: (file: File) => void;
  compact?: boolean;
  kind?: "card" | "badge";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ p: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<string>("kor+eng");
  const [corrected, setCorrected] = useState<boolean | null>(null);
  const [auto, setAuto] = useState(true);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setCorrected(null);
    setPreview(URL.createObjectURL(file));
    try {
      const r = await runOcr(file, (p, label) => setProgress({ p, label }), lang, { autoCorrect: auto });
      setPreview(r.preview);
      setCorrected(r.extra.corrected);
      if (!r.lines.length) throw new Error("empty");
      onLines(r.lines, r.preview, r.extra);
    } catch {
      if (typeof navigator !== "undefined" && navigator.onLine === false && onOfflinePhoto) {
        onOfflinePhoto(file);
      } else {
        setError(kind === "badge" ? "배지 글자를 읽지 못했어요. 이름이 잘 보이도록 가까이에서 다시 촬영하거나 직접 입력하세요." : "글자를 읽지 못했어요. 밝은 곳에서 명함이 화면을 가득 채우도록 다시 촬영하거나 직접 입력하세요.");
      }
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };

  const noun = kind === "badge" ? "행사 배지" : "종이 명함";
  return (
    <div className="space-y-3">
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="scan-input" aria-label={`${noun} 사진 선택`} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={!!progress}
        className={`group relative grid w-full place-items-center overflow-hidden rounded-[28px] border-2 border-dashed border-[var(--line-strong)] bg-[var(--bg-elev)] ${compact ? "aspect-[2/1]" : kind === "badge" ? "aspect-[1/1.1] max-h-[420px]" : "aspect-[1.62/1]"} transition hover:border-[var(--fg)]`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={`촬영한 ${noun}`} className="absolute inset-0 size-full object-contain opacity-90" />
        ) : null}
        {progress && (
          <div className="absolute inset-0 bg-[var(--color-ink)]/40">
            <div className="absolute inset-x-0 h-0.5 bg-[var(--color-signal)] shadow-[0_0_24px_4px_rgba(200,240,60,.7)] motion-reduce:hidden" style={{ top: `${(progress.p * 100) % 100}%`, transition: "top .4s" }} />
          </div>
        )}
        <div className="relative z-10 flex flex-col items-center gap-2 px-6 text-center">
          {progress ? (
            <span role="status" className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-[14px] font-semibold text-white">
              {progress.label} · {Math.round(progress.p * 100)}%
            </span>
          ) : (
            <>
              <span className="grid size-16 place-items-center rounded-full bg-[var(--color-signal)] text-[var(--color-ink)] shadow-lg transition group-hover:scale-105">
                <Icon name="camera" size={28} />
              </span>
              <span className={`text-[17px] font-semibold ${preview ? "rounded-full bg-[var(--color-ink)] px-3 py-1 text-white" : ""}`}>{preview ? "다시 촬영" : `${noun} 촬영`}</span>
              {!preview && <span className="text-[13px] text-[var(--fg-mute)]">테두리·기울기는 자동으로 보정되고, 사진은 이 기기에서만 분석됩니다</span>}
            </>
          )}
        </div>
      </button>
      {corrected !== null && (
        <p className="flex items-center justify-center gap-1.5 text-[12.5px] text-[var(--fg-mute)]" role="status">
          <Icon name={corrected ? "check" : "scan"} size={14} />
          {corrected ? "테두리를 찾아 원근·기울기를 보정했어요" : "테두리를 찾지 못해 원본 그대로 인식했어요"}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-1.5" role="radiogroup" aria-label="인식 언어">
        {OCR_LANGS.map((l) => (
          <button key={l.v} type="button" role="radio" aria-checked={lang === l.v} onClick={() => setLang(l.v)} className={`chip !text-[12px] ${lang === l.v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
            {l.label}
          </button>
        ))}
        <button type="button" role="switch" aria-checked={auto} onClick={() => setAuto(!auto)} className={`chip !text-[12px] ${auto ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
          자동 보정 {auto ? "켜짐" : "꺼짐"}
        </button>
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
