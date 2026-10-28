/**
 * P-196: 파일 업로드 보안 / P-052: 증거 파일 업로드 세션. (N-5)
 *
 * 출처: 03_데이터모델_API명세.md §3 "업로드 파일은 격리 버킷, MIME sniffing, 크기 제한,
 *       malware scan, signed URL 을 적용한다" (보안정책 §2)
 *       스키마: proplus/db/migrations/0001_proplus_core.sql `evidence_files(byte_size > 0, mime_type)`
 *
 * 왜 선언된 Content-Type 을 믿지 않는가:
 *   `declared` 는 **업로더가 보낸 문자열**이다. `image/png` 라고 적고 HTML·SVG·실행 파일을 올리면,
 *   그 파일을 나중에 signed URL 로 내려받아 브라우저가 렌더할 때 우리 오리진에서 스크립트가 돈다.
 *   증거 파일은 검증자가 **반드시 열어보는** 파일이므로(모듈명세 M04) 이 경로가 가장 위험하다.
 *   그래서 선언값은 허용목록 통과용으로만 쓰고, 실제 형식은 매직바이트로 다시 정한다.
 *
 * 왜 SVG 가 허용목록에 없는가: SVG 는 스크립트를 담을 수 있는 XML 문서다 (N-10 과 같은 이유).
 */

/** 증거로 받을 수 있는 형식. 보안정책 §2 의 허용목록이며 블랙리스트 방식을 쓰지 않는다. */
export const EVIDENCE_MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

/**
 * sniff 에 필요한 최소 바이트. webp 판정이 12바이트(RIFF????WEBP)를 요구하므로 그 값에 맞춘다.
 * 호출부는 파일 앞 12바이트 이상을 읽어 넘겨야 한다.
 */
export const MIN_SNIFF_BYTES = 12;

function matches(head: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (head.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (head[offset + i] !== signature[i]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" — RIFF 헤더 뒤 4바이트 길이 다음에 온다
const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

/**
 * 파일 앞부분으로 실제 형식을 판정한다. 알 수 없으면 `null`.
 *
 * PNG 는 4바이트가 아니라 8바이트 서명을 모두 본다 — 뒤 4바이트(`\r\n\x1a\n`)는 전송 중
 * 줄바꿈 변환 여부를 잡기 위해 규격이 일부러 넣은 것이고, 확인 비용이 0 이다.
 */
export function sniffMime(head: Uint8Array): string | null {
  if (head.length < MIN_SNIFF_BYTES) return null;
  if (matches(head, 0, JPEG)) return "image/jpeg";
  if (matches(head, 0, PNG)) return "image/png";
  if (matches(head, 0, RIFF) && matches(head, 8, WEBP)) return "image/webp";
  if (matches(head, 0, PDF)) return "application/pdf";
  return null;
}

/** `image/jpeg; charset=binary` 처럼 파라미터가 붙어 오는 경우가 있어 타입 부분만 떼서 비교한다. */
function normalizeDeclared(declared: string): string {
  if (typeof declared !== "string") return "";
  return (declared.split(";")[0] ?? "").trim().toLowerCase();
}

export type UploadResult = { ok: true; mime: string } | { ok: false; code: string; message: string };

/**
 * 업로드 1건의 적격성. 통과하면 **sniff 로 확정된 mime** 을 돌려주고, 저장되는 값은 이것이다
 * (`evidence_files.mime_type` 에 선언값을 넣으면 거짓말이 그대로 DB 에 남는다).
 */
export function validateUpload(declared: string, size: number, head: Uint8Array): UploadResult {
  const declaredType = normalizeDeclared(declared);
  if (!EVIDENCE_MIME.has(declaredType)) {
    return { ok: false, code: "mime_not_allowed", message: "이미지(JPEG·PNG·WebP) 또는 PDF 만 올릴 수 있습니다." };
  }

  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, code: "invalid_size", message: "파일 크기를 확인할 수 없습니다." };
  }
  if (size > MAX_EVIDENCE_BYTES) {
    const mb = Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024));
    return { ok: false, code: "file_too_large", message: `파일은 ${mb}MB 이하여야 합니다.` };
  }

  const sniffed = sniffMime(head);
  if (!sniffed) {
    return { ok: false, code: "mime_unrecognized", message: "지원하지 않는 파일 형식입니다." };
  }
  // 선언값과 실제 내용이 다르면 **거부한다** (보안정책 §2 MIME sniffing).
  // 실제 형식으로 조용히 고쳐주지 않는 이유: 확장자·Content-Type 과 내용이 어긋난 업로드는
  // 사고가 아니라 시도로 봐야 하고, 거부해야 감사로그에 남는다.
  if (sniffed !== declaredType) {
    return { ok: false, code: "mime_mismatch", message: "파일 형식이 선언한 형식과 다릅니다." };
  }

  return { ok: true, mime: sniffed };
}
