/**
 * P-196 파일 업로드 보안 · P-052 증거 파일 업로드 세션 (N-5)
 *
 * 수용 기준(01_FEATURE_REGISTRY.yaml P-196):
 *   "격리 버킷, MIME sniffing, 크기 제한, signed URL 단기 만료"
 *   — 이 중 **MIME sniffing 과 크기 제한**이 순수 함수로 강제되는 부분이다.
 *
 * 이 함수의 전부는 **선언된 Content-Type 을 신뢰하지 않는 것**이다.
 * 증거 파일은 검증자가 반드시 열어보는 파일이므로(모듈명세 M04),
 * `image/png` 이라 선언하고 HTML·SVG·PDF 를 올리는 경로가 가장 위험하다.
 */

import { describe, expect, it } from "vitest";
import { EVIDENCE_MIME, MAX_EVIDENCE_BYTES, MIN_SNIFF_BYTES, sniffMime, validateUpload } from "../src/mime";

/**
 * 각 허용 형식의 실제 매직바이트. 구현을 베끼지 않고 **규격**에서 가져온다.
 *   JPEG  FF D8 FF            (SOI + 첫 마커)
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  "RIFF" + 길이 4바이트 + "WEBP"
 *   PDF   "%PDF"
 */
const SIGNATURES: Readonly<Record<string, readonly number[]>> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
};

const MIMES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function signature(mime: string): readonly number[] {
  const sig = SIGNATURES[mime];
  if (!sig) throw new Error(`테스트에 ${mime} 의 매직바이트 정의가 없다`);
  return sig;
}

/** 앞부분 바이트 + 0 패딩. length 를 줄이면 "head 가 너무 짧은" 경우를 만든다. */
function head(bytes: readonly number[], length = MIN_SNIFF_BYTES): Uint8Array {
  const out = new Uint8Array(Math.max(length, 0));
  for (let i = 0; i < bytes.length && i < out.length; i++) out[i] = bytes[i] ?? 0;
  return out;
}

function headFor(mime: string, length = MIN_SNIFF_BYTES): Uint8Array {
  return head(signature(mime), length);
}

describe("P-196: 허용목록은 블랙리스트가 아니다 (보안정책 §2)", () => {
  it("증거로 받을 수 있는 형식은 JPEG·PNG·WebP·PDF 네 가지다", () => {
    // 테스트의 전수 루프가 새 형식을 조용히 건너뛰지 못하게 목록 자체를 고정한다.
    expect([...EVIDENCE_MIME].sort()).toEqual([...MIMES].sort());
  });

  it("SVG 는 허용되지 않는다 (스크립트를 담을 수 있는 XML 문서다 — N-10)", () => {
    expect(EVIDENCE_MIME.has("image/svg+xml")).toBe(false);
  });
});

describe("P-196: 매직바이트 판별 (sniffMime)", () => {
  it("네 형식을 각각 서명으로 알아본다", () => {
    for (const mime of MIMES) {
      expect(sniffMime(headFor(mime)), `${mime} 판별 실패`).toBe(mime);
    }
  });

  it("판별 결과는 항상 허용목록 안의 값이다", () => {
    for (const mime of MIMES) {
      const sniffed = sniffMime(headFor(mime));
      expect(sniffed).not.toBeNull();
      expect(EVIDENCE_MIME.has(sniffed ?? "")).toBe(true);
    }
  });

  it("PNG 는 8바이트 서명을 모두 확인한다 (뒤 4바이트가 깨진 파일을 통과시키지 않는다)", () => {
    expect(sniffMime(head([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffMime(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]))).toBeNull();
  });

  it("RIFF 컨테이너지만 WEBP 가 아니면 거부한다 (WAV·AVI)", () => {
    const wav = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]; // "WAVE"
    const avi = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]; // "AVI "
    expect(sniffMime(head(wav))).toBeNull();
    expect(sniffMime(head(avi))).toBeNull();
  });

  it("알 수 없는 내용은 null 이다", () => {
    const html = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 0x20, 0x68, 0x74]; // "<!DOCTYPE ht"
    const svg = [0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x22]; // "<svg xmlns=\""
    const zip = [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0];
    const elf = [0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const bytes of [html, svg, zip, elf]) {
      expect(sniffMime(head(bytes))).toBeNull();
    }
    expect(sniffMime(head([], 12))).toBeNull(); // 전부 0
  });

  it(`경계: head 가 ${MIN_SNIFF_BYTES}바이트 미만이면 판별하지 않는다`, () => {
    // 서명이 4바이트인 PDF 라도 판별하지 않는다 — 호출부가 충분히 읽어 보냈음을 보장받아야 한다.
    for (const mime of MIMES) {
      expect(sniffMime(headFor(mime, MIN_SNIFF_BYTES - 1)), `${mime} / 11바이트`).toBeNull();
      expect(sniffMime(headFor(mime, MIN_SNIFF_BYTES)), `${mime} / 12바이트`).toBe(mime);
    }
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });

  it("head 가 길어도(실제 파일 전체) 판별은 같다", () => {
    for (const mime of MIMES) {
      expect(sniffMime(headFor(mime, 4096)), `${mime} / 4096바이트`).toBe(mime);
    }
  });
});

describe("P-196: declared 를 신뢰하지 않는다 — 선언과 내용이 다르면 거부", () => {
  it("'image/png' 이라 선언하고 PDF 바이트를 보내면 거부한다", () => {
    const r = validateUpload("image/png", 1024, headFor("application/pdf"));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("mime_mismatch");
  });

  it("선언×내용 전수: 일치하면 통과, 어긋나면 mime_mismatch", () => {
    for (const declared of MIMES) {
      for (const actual of MIMES) {
        const r = validateUpload(declared, 1024, headFor(actual));
        if (declared === actual) {
          expect(r.ok, `${declared} / ${actual} 가 막혔다`).toBe(true);
          // 저장되는 값은 **sniff 로 확정된 mime** 이다 (선언값을 넣으면 거짓말이 DB 에 남는다).
          expect(r.ok && r.mime).toBe(actual);
        } else {
          expect(r.ok === false && r.code, `${declared} 선언 + ${actual} 내용`).toBe("mime_mismatch");
        }
      }
    }
  });

  it("내용을 알아볼 수 없으면 선언이 허용목록 안이라도 거부한다", () => {
    const svgBytes = [0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x22];
    for (const declared of MIMES) {
      const r = validateUpload(declared, 1024, head(svgBytes));
      expect(r.ok === false && r.code, `${declared} 선언 + SVG 내용`).toBe("mime_unrecognized");
    }
  });

  it("head 가 짧으면 통과시키지 않는다 (판별 불가를 통과로 바꾸지 않는다)", () => {
    const r = validateUpload("application/pdf", 1024, headFor("application/pdf", MIN_SNIFF_BYTES - 1));
    expect(r.ok === false && r.code).toBe("mime_unrecognized");
  });
});

describe("P-196: 선언된 MIME 허용목록", () => {
  it("허용목록 밖 선언은 내용이 멀쩡해도 거부한다", () => {
    const notAllowed = [
      "image/svg+xml",
      "text/html",
      "text/plain",
      "image/gif",
      "image/bmp",
      "application/zip",
      "application/octet-stream",
      "application/x-msdownload",
      "multipart/form-data",
      "",
      "png",
      "image",
      ";image/png", // 파라미터 분리 뒤 빈 타입
    ];
    for (const declared of notAllowed) {
      const r = validateUpload(declared, 1024, headFor("image/png"));
      expect(r.ok === false && r.code, `선언 ${JSON.stringify(declared)}`).toBe("mime_not_allowed");
    }
  });

  it("파라미터·대문자·공백이 붙은 선언은 정규화해 받아들인다", () => {
    for (const declared of ["image/png; charset=binary", "IMAGE/PNG", "  image/png  ", "image/png;"]) {
      const r = validateUpload(declared, 1024, headFor("image/png"));
      expect(r.ok, `선언 ${JSON.stringify(declared)} 가 막혔다`).toBe(true);
      expect(r.ok && r.mime).toBe("image/png");
    }
  });

  it("문자열이 아닌 선언은 거부한다", () => {
    for (const declared of [null, undefined, 42, {}]) {
      const r = validateUpload(declared as unknown as string, 1024, headFor("image/png"));
      expect(r.ok === false && r.code, `선언 ${JSON.stringify(declared)}`).toBe("mime_not_allowed");
    }
  });
});

describe("P-196: 크기 경계", () => {
  it(`경계: ${MAX_EVIDENCE_BYTES} 바이트는 통과하고 +1 은 거부한다`, () => {
    expect(validateUpload("image/png", MAX_EVIDENCE_BYTES, headFor("image/png")).ok).toBe(true);
    const over = validateUpload("image/png", MAX_EVIDENCE_BYTES + 1, headFor("image/png"));
    expect(over.ok === false && over.code).toBe("file_too_large");
  });

  it("1바이트는 통과하고 0·음수·소수·NaN·Infinity 는 invalid_size 다", () => {
    expect(validateUpload("image/png", 1, headFor("image/png")).ok).toBe(true);
    for (const size of [0, -1, -1024, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validateUpload("image/png", size, headFor("image/png"));
      expect(r.ok === false && r.code, `size=${size}`).toBe("invalid_size");
    }
  });
});

describe("P-196: 검사 순서 (감사로그에 남는 거부 사유가 바뀌면 안 된다)", () => {
  it("허용목록 밖 선언이 가장 먼저 걸린다", () => {
    const r = validateUpload("text/html", 0, new Uint8Array(0));
    expect(r.ok === false && r.code).toBe("mime_not_allowed");
  });

  it("크기 검사가 sniff 보다 먼저다 (큰 파일을 읽기 전에 끊는다)", () => {
    const r = validateUpload("image/png", MAX_EVIDENCE_BYTES + 1, headFor("application/pdf"));
    expect(r.ok === false && r.code).toBe("file_too_large");
  });

  it("거부 메시지에 내부 사정을 담지 않는다 (사용자에게 설명 가능한 한국어)", () => {
    const r = validateUpload("image/png", 1024, headFor("application/pdf"));
    expect(r.ok === false && r.message.length).toBeGreaterThan(0);
    expect(r.ok === false && r.message).not.toContain("sniff");
  });
});
