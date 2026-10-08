// F-172 Malware Scan: 업로드 파일은 (1) 크기 제한, (2) magic-byte 로 실제 형식 확인(확장자/Content-Type 불신),
// (3) 이미지는 서버에서 재인코딩(sharp: 메타데이터·EXIF GPS 제거, polyglot 무력화), (4) PDF 능동 콘텐츠 검사,
// (5) 선택적 ClamAV(clamd INSTREAM over TCP, CLAMAV_HOST) 를 거친다. 탐지 시 저장은 하되 quarantined 로 격리해 다운로드를 막는다.
import { createConnection } from "node:net";
import { ApiError, unavailable } from "./errors";
import { log } from "./platform";

export type UploadPurpose = "card_image" | "profile_media" | "room_file" | "recording_part";

const MB = 1024 * 1024;
export const UPLOAD_POLICY: Record<UploadPurpose, { maxBytes: number; types: string[] }> = {
  card_image: { maxBytes: 15 * MB, types: ["image/jpeg", "image/png", "image/webp"] },
  profile_media: { maxBytes: 20 * MB, types: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] },
  room_file: { maxBytes: 25 * MB, types: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] },
  recording_part: { maxBytes: 12 * MB, types: ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"] },
};

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString("latin1");

/** Detect the real file type from its first bytes. Returns null for anything not on our allow-lists. */
export function sniffType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (/^(heic|heix|mif1|msf1|avif)$/.test(brand)) return null; // not accepted: clients send JPEG
    return "audio/mp4";
  }
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|AA|SubmitForm|ImportData|GoToR)\b/;

export interface InspectedUpload {
  bytes: Buffer;
  contentType: string;
  scanStatus: "clean" | "quarantined" | "unscanned";
  engine: string;
  detail: string | null;
  sanitized: boolean;
}

async function reencodeImage(buf: Buffer, type: string): Promise<{ bytes: Buffer; type: string } | null> {
  let sharp: typeof import("sharp") | null = null;
  try {
    sharp = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    return null;
  }
  try {
    const img = sharp(buf, { limitInputPixels: 50_000_000, failOn: "error", animated: false }).rotate().resize({ width: 3200, height: 3200, fit: "inside", withoutEnlargement: true });
    // metadata (EXIF incl. GPS, XMP, ICC comments) is dropped because withMetadata() is never called
    if (type === "image/png" || type === "image/gif") return { bytes: await img.png({ compressionLevel: 8 }).toBuffer(), type: "image/png" };
    if (type === "image/webp") return { bytes: await img.webp({ quality: 88 }).toBuffer(), type: "image/webp" };
    return { bytes: await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer(), type: "image/jpeg" };
  } catch (e) {
    throw new ApiError(415, "invalid_image", "이미지 파일을 해석할 수 없습니다.", { reason: (e as Error).message.slice(0, 120) });
  }
}

/** clamd INSTREAM over TCP. Returns null when CLAMAV_HOST is not configured. */
export async function clamdScan(buf: Buffer): Promise<{ infected: boolean; signature: string | null } | null> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return null;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const timeout = Number(process.env.CLAMAV_TIMEOUT_MS ?? 15000);
  return new Promise((resolveP, rejectP) => {
    const sock = createConnection({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      rejectP(new Error("clamd timeout"));
    }, timeout);
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const part = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on("data", (d) => {
      chunks.push(d);
      if (d.includes(0)) sock.end();
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      const reply = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
      if (/\bOK$/.test(reply)) resolveP({ infected: false, signature: null });
      else {
        const m = reply.match(/:\s*(.+)\s+FOUND$/);
        if (m) resolveP({ infected: true, signature: m[1]! });
        else rejectP(new Error(`clamd: ${reply.slice(0, 120) || "no reply"}`));
      }
    });
  });
}

/**
 * Validate + sanitize + scan an upload. Throws 413/415 for files that must not be stored at all;
 * returns quarantined status for files that are stored (for audit) but never served.
 */
export async function inspectUpload(purpose: UploadPurpose, input: Buffer, opts: { skipReencode?: boolean } = {}): Promise<InspectedUpload> {
  const policy = UPLOAD_POLICY[purpose];
  if (!input.length) throw new ApiError(400, "empty_upload", "빈 파일입니다.");
  if (input.length > policy.maxBytes) throw new ApiError(413, "file_too_large", `파일이 너무 큽니다(최대 ${Math.round(policy.maxBytes / MB)}MB).`);
  const type = sniffType(input);
  if (!type || !policy.types.includes(type)) throw new ApiError(415, "unsupported_file_type", "허용되지 않는 파일 형식입니다.", { detected: type });
  let bytes = input;
  let contentType = type;
  let sanitized = false;
  let status: InspectedUpload["scanStatus"] = "clean";
  let engine = "linkos-validate";
  let detail: string | null = null;

  if (type.startsWith("image/") && !opts.skipReencode) {
    const r = await reencodeImage(input, type);
    if (r) {
      bytes = r.bytes;
      contentType = r.type;
      sanitized = true;
      engine += "+sharp";
    } else detail = "not_reencoded";
  }
  if (type === "application/pdf") {
    const text = input.toString("latin1");
    const hit = text.match(PDF_ACTIVE);
    if (hit) {
      status = "quarantined";
      detail = `pdf_active_content:${hit[1]}`;
    }
  }
  if (input.includes(EICAR)) {
    status = "quarantined";
    detail = "builtin:EICAR-Test-File";
  }
  try {
    const av = await clamdScan(input);
    if (av) {
      engine += "+clamav";
      if (av.infected) {
        status = "quarantined";
        detail = `clamav:${av.signature}`;
      }
    } else if (status === "clean" && process.env.CLAMAV_REQUIRED === "1") {
      throw unavailable("malware_scanner_unavailable", "악성코드 검사기가 설정되지 않았습니다.");
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    log("warn", "upload.clamd_failed", { error: (e as Error).message });
    if (process.env.CLAMAV_REQUIRED === "1") throw unavailable("malware_scanner_unavailable", "악성코드 검사기에 연결할 수 없습니다.");
    if (status === "clean") {
      status = "unscanned";
      detail = "clamav_unreachable";
    }
  }
  return { bytes, contentType, scanStatus: status, engine, detail, sanitized };
}
