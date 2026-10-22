// 서버 OCR 어댑터 (선택) — F-015 다국어 인식의 정확도 폴백.
//
// 기본 경로는 **기기 내 OCR**(tesseract.js)이고 사진은 기기를 떠나지 않는다. 그런데 한국어 명함은
// 가로/세로 혼용·작은 글씨·금박 인쇄에서 기기 OCR 이 전화번호를 아예 못 읽는 일이 있다. 그때만,
// 사용자가 "사진을 서버와 Google 로 보내 다시 읽기"에 명시적으로 동의한 경우에 이 어댑터를 쓴다.
//
// 지키는 것
//  - 키(GOOGLE_VISION_API_KEY)가 없으면 아예 제안하지 않는다(화면에 버튼이 나타나지 않는다).
//  - 이미지는 메모리에서만 다루고 저장하지 않는다. 원문 텍스트도 보관하지 않고 줄 단위로 넘긴다.
//  - 의미 구조화(이름/회사/전화 분류)는 여전히 서버의 결정적 파서가 한다 — OCR 은 글자만 읽는다.
import { type OcrLine } from "@linkos/domain";
import { ApiError } from "./errors";
import { log } from "./platform";

const VISION_URL = () => (process.env.GOOGLE_VISION_API_BASE ?? "https://vision.googleapis.com").replace(/\/$/, "") + "/v1/images:annotate";

export function serverOcrAvailable(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY?.trim());
}

export const SERVER_OCR_ENGINE = "google-vision";

interface VisionVertex {
  x?: number;
  y?: number;
}
interface VisionWord {
  symbols?: { text?: string }[];
  confidence?: number;
  boundingBox?: { vertices?: VisionVertex[] };
}
interface VisionParagraph {
  words?: VisionWord[];
}
interface VisionBlock {
  paragraphs?: VisionParagraph[];
}
interface VisionPage {
  blocks?: VisionBlock[];
}
interface VisionResponse {
  responses?: {
    error?: { message?: string };
    fullTextAnnotation?: { text?: string; pages?: VisionPage[] };
  }[];
}

function bboxOf(words: VisionWord[]): OcrLine["bbox"] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const w of words) for (const v of w.boundingBox?.vertices ?? []) {
    if (typeof v.x === "number") xs.push(v.x);
    if (typeof v.y === "number") ys.push(v.y);
  }
  if (!xs.length || !ys.length) return undefined;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * DOCUMENT_TEXT_DETECTION 결과를 파서가 기대하는 줄 단위로 바꾼다.
 * Vision 은 단어(word)까지 내려 주고 줄바꿈은 detectedBreak 로 표시하므로, 문단 안의 단어를 모아
 * 줄로 합치되 bbox 와 신뢰도(0..1)를 같이 보존한다 — 파서가 bbox 로 이름/회사를 가린다.
 */
export function visionLines(body: VisionResponse): OcrLine[] {
  const first = body.responses?.[0];
  if (first?.error?.message) throw new Error(first.error.message);
  const pages = first?.fullTextAnnotation?.pages ?? [];
  const lines: OcrLine[] = [];
  for (const page of pages) {
    for (const block of page.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        const words = para.words ?? [];
        if (!words.length) continue;
        const text = words.map((w) => (w.symbols ?? []).map((s) => s.text ?? "").join("")).join(" ").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const confs = words.map((w) => w.confidence).filter((c): c is number => typeof c === "number");
        lines.push({
          text,
          confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
          bbox: bboxOf(words),
        });
      }
    }
  }
  // 구조(pages)가 비어 있을 때의 폴백: 전체 텍스트를 줄로 쪼갠다(신뢰도·bbox 없음 → 파서가 기본값 사용)
  if (!lines.length) {
    for (const t of (first?.fullTextAnnotation?.text ?? "").split("\n")) {
      const text = t.replace(/\s+/g, " ").trim();
      if (text) lines.push({ text });
    }
  }
  return lines;
}

/**
 * 사진 1장 → OCR 줄. 호출자는 사용자의 명시적 동의를 먼저 받아야 한다.
 * 비용(ocr.page.server)은 capture 모듈이 engine 이름으로 기록한다 — 여기서 중복 기록하지 않는다.
 */
export async function serverOcr(jpeg: Buffer): Promise<{ lines: OcrLine[]; engine: string }> {
  const key = process.env.GOOGLE_VISION_API_KEY?.trim();
  if (!key) throw new ApiError(503, "server_ocr_not_configured", "서버 OCR이 설정되지 않았습니다. 기기에서 다시 촬영하거나 번호를 직접 입력해 주세요.");
  const payload = {
    requests: [
      {
        image: { content: jpeg.toString("base64") },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: ["ko", "en"] },
      },
    ],
  };
  let res: Response;
  try {
    res = await fetch(`${VISION_URL()}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    log("warn", "ocr.server_unreachable", { error: (e as Error).name });
    throw new ApiError(503, "server_ocr_unavailable", "서버 OCR에 연결하지 못했습니다. 기기에서 다시 촬영해 주세요.");
  }
  if (!res.ok) {
    log("warn", "ocr.server_failed", { status: res.status });
    throw new ApiError(res.status === 429 ? 429 : 503, "server_ocr_failed", `서버 OCR이 실패했습니다(HTTP ${res.status}). 기기에서 다시 촬영해 주세요.`);
  }
  let lines: OcrLine[];
  try {
    lines = visionLines((await res.json()) as VisionResponse);
  } catch (e) {
    log("warn", "ocr.server_rejected", { error: (e as Error).message });
    throw new ApiError(503, "server_ocr_failed", "서버 OCR이 이미지를 읽지 못했습니다. 더 밝은 곳에서 다시 촬영해 주세요.");
  }
  return { lines, engine: SERVER_OCR_ENGINE };
}
