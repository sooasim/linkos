// 서버 OCR 폴백(Google Vision) 어댑터. DB 없이 응답 변환과 설정 감지를 덮는다.
// 의미 구조화는 도메인 파서 몫이므로 여기서는 "줄·신뢰도·bbox 로 정확히 바뀌는가"만 본다.
import { parseBusinessCard } from "@linkos/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_OCR_ENGINE, serverOcr, serverOcrAvailable, visionLines } from "../src/lib/ocr";

const KEYS = ["GOOGLE_VISION_API_KEY", "GOOGLE_VISION_API_BASE"] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;
const realFetch = globalThis.fetch;

/** 단어를 symbols 로 쪼갠 Vision 응답 조각 */
const word = (text: string, box: [number, number, number, number], confidence?: number) => ({
  symbols: [...text].map((c) => ({ text: c })),
  confidence,
  boundingBox: { vertices: [{ x: box[0], y: box[1] }, { x: box[2], y: box[1] }, { x: box[2], y: box[3] }, { x: box[0], y: box[3] }] },
});

const visionBody = (paragraphs: { words: ReturnType<typeof word>[] }[], text = "") => ({
  responses: [{ fullTextAnnotation: { text, pages: [{ blocks: [{ paragraphs }] }] } }],
});

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("설정 감지", () => {
  it("키가 없으면 제안하지 않고, 호출하면 503 으로 분명히 거절한다", async () => {
    expect(serverOcrAvailable()).toBe(false);
    await expect(serverOcr(Buffer.from("x"))).rejects.toMatchObject({ code: "server_ocr_not_configured" });
  });

  it("키가 있으면 쓸 수 있다", () => {
    process.env.GOOGLE_VISION_API_KEY = "k";
    expect(serverOcrAvailable()).toBe(true);
  });
});

describe("visionLines", () => {
  it("문단의 단어를 줄로 합치고 신뢰도 평균과 bbox 를 보존한다", () => {
    const lines = visionLines(
      visionBody([
        { words: [word("김도윤", [40, 30, 180, 80], 0.98), word("대표", [190, 35, 250, 78], 0.9)] },
        { words: [word("010-2345-6789", [40, 120, 300, 150], 0.99)] },
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: "김도윤 대표", bbox: { x0: 40, y0: 30, x1: 250, y1: 80 } });
    expect(lines[0]!.confidence).toBeCloseTo(0.94, 2);
    expect(lines[1]!.text).toBe("010-2345-6789");
  });

  it("신뢰도가 없는 단어는 undefined 로 남긴다 — 파서가 기본값을 쓴다(0 으로 깎지 않는다)", () => {
    const lines = visionLines(visionBody([{ words: [word("아크로", [0, 0, 10, 10])] }]));
    expect(lines[0]!.confidence).toBeUndefined();
  });

  it("구조가 비면 전체 텍스트를 줄로 쪼개 폴백한다", () => {
    const lines = visionLines({ responses: [{ fullTextAnnotation: { text: "김도윤\n아크로 메디컬\n\n010-2345-6789", pages: [] } }] });
    expect(lines.map((l) => l.text)).toEqual(["김도윤", "아크로 메디컬", "010-2345-6789"]);
  });

  it("Vision 이 오류를 돌려주면 그대로 올린다", () => {
    expect(() => visionLines({ responses: [{ error: { message: "API key not valid" } }] })).toThrow(/API key not valid/);
  });

  it("아무것도 못 읽으면 빈 배열이다(호출자가 422 로 안내한다)", () => {
    expect(visionLines({ responses: [{}] })).toEqual([]);
  });

  it("결과는 기존 도메인 파서가 그대로 구조화할 수 있다", () => {
    const lines = visionLines(
      visionBody([
        { words: [word("김도윤", [40, 30, 180, 80], 0.98)] },
        { words: [word("아크로", [40, 90, 150, 115], 0.95), word("메디컬", [155, 90, 240, 115], 0.95)] },
        { words: [word("M.", [40, 130, 60, 150], 0.9), word("010-2345-6789", [65, 130, 300, 150], 0.99)] },
        { words: [word("doyun@acro.kr", [40, 160, 280, 182], 0.97)] },
      ]),
    );
    const parsed = parseBusinessCard(lines);
    const value = (key: string) => parsed.fields.find((f) => f.key === key)?.normalized ?? parsed.fields.find((f) => f.key === key)?.value;
    expect(value("mobile")).toBe("+821023456789");
    expect(value("email")).toBe("doyun@acro.kr");
    expect(value("fullName")).toBe("김도윤");
  });
});

describe("serverOcr 호출", () => {
  beforeEach(() => {
    process.env.GOOGLE_VISION_API_KEY = "k";
    process.env.GOOGLE_VISION_API_BASE = "https://vision.test";
  });

  it("DOCUMENT_TEXT_DETECTION + ko/en 힌트로 보내고 키는 쿼리에만 붙인다", async () => {
    let seen: any = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => visionBody([{ words: [word("김도윤", [0, 0, 10, 10], 0.9)] }]) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await serverOcr(Buffer.from("jpeg-bytes"));
    expect(r.engine).toBe(SERVER_OCR_ENGINE);
    expect(r.lines[0]!.text).toBe("김도윤");
    expect(seen.url).toBe("https://vision.test/v1/images:annotate?key=k");
    expect(seen.body.requests[0].features).toEqual([{ type: "DOCUMENT_TEXT_DETECTION" }]);
    expect(seen.body.requests[0].imageContext.languageHints).toEqual(["ko", "en"]);
    expect(seen.body.requests[0].image.content).toBe(Buffer.from("jpeg-bytes").toString("base64"));
  });

  it("연결 실패·오류는 사용자가 다음에 할 일이 적힌 503 으로 바꾼다", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(serverOcr(Buffer.from("x"))).rejects.toMatchObject({ code: "server_ocr_unavailable", status: 503 });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(serverOcr(Buffer.from("x"))).rejects.toMatchObject({ code: "server_ocr_failed" });
  });

  it("요청량 초과는 429 로 그대로 전달한다", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(serverOcr(Buffer.from("x"))).rejects.toMatchObject({ status: 429 });
  });
});
