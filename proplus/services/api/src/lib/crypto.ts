// 필드 단위 저장 암호화 (보안정책 §3 / 데이터모델 §1).
//
// 어디에 쓰이는가: `leads.contact_channel_encrypted`(P-102 — 평문 연락처 컬럼이 스키마에 없다),
// `idempotency_keys.response`(P-185 — 응답 본문에 PII·일회성 토큰이 들어갈 수 있다),
// `evidence_files` 본문(N-5 / storage.ts).
//
// 왜 버전 접두사(`v1:`)인가: 키 회전 시 이전 키로 봉인된 값을 **읽을 수 있어야** 교체가 가능하다.
// 접두사가 없으면 회전은 전수 재암호화를 멈춤 없이 해야 하는 작업이 되고, 그래서 아무도 회전하지 않는다.
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // GCM 권장 nonce 길이
const BYTES_VERSION = 0x01; // Buffer 형식의 버전 바이트 (문자열 접두사와 같은 목적)

let cached: { raw: string; key: Buffer } | null = null;

/** FIELD_KEY: base64 로 인코딩한 32바이트. 없거나 길이가 다르면 **조용히 평문으로 저장하지 않고** 실패한다. */
export function fieldKey(): Buffer {
  const raw = process.env.FIELD_KEY;
  if (!raw) {
    throw new Error("FIELD_KEY 가 설정되지 않았습니다 — 연락처·응답 본문을 평문으로 저장할 수 없습니다 (보안정책 §3). 32바이트 키를 base64 로 넣으세요: `openssl rand -base64 32`");
  }
  if (cached?.raw === raw) return cached.key;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`FIELD_KEY 는 base64 로 인코딩한 32바이트여야 합니다 (현재 ${key.length}바이트)`);
  }
  cached = { raw, key };
  return key;
}

/** 키가 주입되어 있는지. 설정 점검(헬스체크)용이며, 분기해서 평문 경로를 타는 데 쓰면 안 된다. */
export function fieldKeyConfigured(): boolean {
  try {
    fieldKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param aad 이 암호문을 특정 레코드에 묶어 두는 추가 인증 데이터(예: `lead:<id>`).
 *   왜 쓰는가: AAD 가 없으면 DB 쓰기 권한을 얻은 공격자가 암호문을 **다른 행으로 옮겨** 복호화시킬 수 있다.
 * @returns `v1:<iv_b64>:<tag_b64>:<ct_b64>`
 */
export function encryptField(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", fieldKey(), iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [VERSION, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptField(sealed: string, aad?: string): string {
  const parts = sealed.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("암호문 형식이 올바르지 않습니다 (기대 형식: v1:iv:tag:ct)");
  }
  const d = createDecipheriv("aes-256-gcm", fieldKey(), Buffer.from(ivB64, "base64"));
  if (aad) d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}

/** 바이너리(증거 파일 원본)용. 형식: `[0x01][iv 12][tag 16][ciphertext]` — 문자열 접두사와 같은 이유로 버전 바이트를 둔다. */
export function encryptBytes(plaintext: Buffer, aad?: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", fieldKey(), iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([BYTES_VERSION]), iv, c.getAuthTag(), ct]);
}

export function decryptBytes(blob: Buffer, aad?: string): Buffer {
  if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== BYTES_VERSION) {
    throw new Error("암호화된 객체 형식이 올바르지 않습니다");
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + 16);
  const d = createDecipheriv("aes-256-gcm", fieldKey(), iv);
  if (aad) d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(1 + IV_BYTES + 16)), d.final()]);
}

/** `evidence_files.encryption_ref` 에 넣는 값. 어느 키 체계로 봉인했는지만 남긴다 — 키 자체는 DB 에 들어오지 않는다. */
export const ENCRYPTION_REF = `field-key:${VERSION}`;
