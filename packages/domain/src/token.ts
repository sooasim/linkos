// F-050 토큰 보안: >=128bit 랜덤, PII 없음, DB에는 해시만 저장.

const B64URL = /^[A-Za-z0-9_-]+$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 192-bit random token (exceeds the 128-bit minimum). Contains no PII. */
export function generateToken(bytes = 24): string {
  if (bytes < 16) throw new Error("token entropy must be >= 128 bits");
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

export function isWellFormedToken(token: string): boolean {
  // 16 bytes -> 22 chars minimum in base64url
  return token.length >= 22 && token.length <= 128 && B64URL.test(token);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// F-045 단축코드(교환 코드): 사람이 읽고 말하기 쉬운 **숫자 4자리**(0000~9999, 무작위 — 순번 아님).
// 엔트로피가 낮으므로(10,000가지) 반드시 함께 쓰는 방어: 10분 TTL · 1회성 · 만료 즉시 재사용 해제 ·
// IP별/전체 "틀린 코드" 시도 제한(handoff.guardCodeLookup). 오래 쓰는 행사 참가 코드는 별도(generateShortCode, 6자리).
export const EXCHANGE_CODE_LENGTH = 4;

function randomIndex(n: number): number {
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n; // rejection sampling: no modulo bias
  }
}

/** 4 uniformly random digits, e.g. "0427" (leading zeros allowed). */
export function generateExchangeCode(): string {
  let out = "";
  for (let i = 0; i < EXCHANGE_CODE_LENGTH; i++) out += String(randomIndex(10));
  return out;
}

// 행사 참가 코드 등 오래 유지되는 코드: 6자리, 헷갈리는 0/O, 1/I/L 제외
const SHORT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateShortCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += SHORT_ALPHABET[randomIndex(SHORT_ALPHABET.length)]!;
  return out;
}

/** User input → canonical exchange code ("12 34", "12-34", "lk.to/1234", full-width "１２３４" → "1234"); null if not 4 digits. */
export function normalizeShortCode(input: string): string | null {
  const s = input
    .normalize("NFKC")
    .replace(/^\s*(https?:\/\/)?(lk\.to|[^/]+\/c)\//i, "")
    .replace(/[\s-]/g, "");
  return /^\d{4}$/.test(s) ? s : null;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
