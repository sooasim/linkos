"use client";
// F-010 카메라 촬영 — 자동 테두리 검출·크롭·원근/회전 보정(homography warp) + 명암 보정 후 OCR,
// F-011 앞·뒤면, F-014 배지, F-015 다국어 OCR. 이미지는 기기 안에서 처리된다(on-device OCR);
// 원본 보관(F-019)은 사용자가 명시적으로 켠 경우에만 상위 화면이 업로드한다.
import { type Locale, SCANNER_MESSAGES, fmt } from "@linkos/domain";
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
export async function runOcr(file: Blob, onProgress: (p: number, label: string) => void, langs = "kor+eng", opts: { autoCorrect?: boolean; locale?: Locale } = {}): Promise<{ lines: OcrLineOut[]; extra: ScanExtra; preview: string }> {
  const t = SCANNER_MESSAGES[opts.locale ?? "ko"];
  onProgress(0.03, t.findingEdges);
  const pipe = await import("@/lib/imagePipeline");
  const { ocrCanvas } = await import("@/lib/ocr");
  const base = await pipe.loadCanvas(file);
  const fixed = opts.autoCorrect === false ? { canvas: base, detection: null } : pipe.autoCorrect(base);
  onProgress(0.1, fixed.detection ? t.perspectiveDone : t.enhancing);
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
  locale = "ko",
}: {
  onLines: (lines: OcrLineOut[], preview: string, extra?: ScanExtra) => void;
  onManual?: () => void;
  /** called with the photo when on-device OCR cannot run offline (language data not cached) */
  onOfflinePhoto?: (file: File) => void;
  compact?: boolean;
  kind?: "card" | "badge";
  /** UI language (the guest landing passes the negotiated Accept-Language locale) */
  locale?: Locale;
}) {
  const t = SCANNER_MESSAGES[locale] ?? SCANNER_MESSAGES.ko;
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ p: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<string>(locale === "ja" ? "jpn+eng" : "kor+eng");
  const [corrected, setCorrected] = useState<boolean | null>(null);
  const [auto, setAuto] = useState(true);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setCorrected(null);
    setPreview(URL.createObjectURL(file));
    try {
      const r = await runOcr(file, (p, label) => setProgress({ p, label }), lang, { autoCorrect: auto, locale });
      setPreview(r.preview);
      setCorrected(r.extra.corrected);
      if (!r.lines.length) throw new Error("empty");
      onLines(r.lines, r.preview, r.extra);
    } catch {
      if (typeof navigator !== "undefined" && navigator.onLine === false && onOfflinePhoto) {
        onOfflinePhoto(file);
      } else {
        setError(kind === "badge" ? t.readFailedBadge : t.readFailedCard);
      }
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };

  const noun = kind === "badge" ? t.nounBadge : t.nounCard;
  return (
    <div className="space-y-3">
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="scan-input" aria-label={fmt(t.pickPhoto, { noun })} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={!!progress}
        className={`group relative grid w-full place-items-center overflow-hidden rounded-[28px] border-2 border-dashed border-[var(--line-strong)] bg-[var(--bg-elev)] ${compact ? "aspect-[2/1]" : kind === "badge" ? "aspect-[1/1.1] max-h-[420px]" : "aspect-[1.62/1]"} transition hover:border-[var(--fg)]`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={fmt(t.captured, { noun })} className="absolute inset-0 size-full object-contain opacity-90" />
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
              <span className={`text-[17px] font-semibold ${preview ? "rounded-full bg-[var(--color-ink)] px-3 py-1 text-white" : ""}`}>{preview ? t.retake : fmt(t.shoot, { noun })}</span>
              {!preview && <span className="text-[13px] text-[var(--fg-mute)]">{t.hint}</span>}
            </>
          )}
        </div>
      </button>
      {corrected !== null && (
        <p className="flex items-center justify-center gap-1.5 text-[12.5px] text-[var(--fg-mute)]" role="status">
          <Icon name={corrected ? "check" : "scan"} size={14} />
          {corrected ? t.corrected : t.notCorrected}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-1.5" role="radiogroup" aria-label={t.ocrLanguage}>
        {OCR_LANGS.map((l) => (
          <button key={l.v} type="button" role="radio" aria-checked={lang === l.v} onClick={() => setLang(l.v)} className={`chip !text-[12px] ${lang === l.v ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
            {l.label}
          </button>
        ))}
        <button type="button" role="switch" aria-checked={auto} onClick={() => setAuto(!auto)} className={`chip !text-[12px] ${auto ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
          {t.autoFix} {auto ? t.on : t.off}
        </button>
      </div>
      {error && <p role="alert" className="rounded-2xl bg-[var(--color-ember)]/10 px-4 py-3 text-[14px] text-[var(--color-ember)]">{error}</p>}
      {onManual && (
        <button type="button" onClick={onManual} className="w-full py-2 text-[14px] font-medium text-[var(--fg-mute)] underline-offset-4 hover:underline" data-testid="manual-entry">
          {t.manual}
        </button>
      )}
    </div>
  );
}
