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

// F-045 단축코드: 사람이 입력하기 쉬운 6자리. 엔트로피가 낮으므로 짧은 TTL + rate limit + 1회 해석 후 전체 토큰으로 교체.
const SHORT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 0/O, 1/I/L 제외

export function generateShortCode(length = 6): string {
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  globalThis.crypto.getRandomValues(buf);
  // rejection sampling to avoid modulo bias
  const limit = 256 - (256 % SHORT_ALPHABET.length);
  let i = 0;
  while (out.length < length) {
    if (i >= buf.length) {
      globalThis.crypto.getRandomValues(buf);
      i = 0;
    }
    const v = buf[i++]!;
    if (v < limit) out.push(SHORT_ALPHABET[v % SHORT_ALPHABET.length]!);
  }
  return out.join("");
}

export function normalizeShortCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/^LK\.TO\//, "");
  if (s.length !== 6) return null;
  for (const ch of s) if (!SHORT_ALPHABET.includes(ch)) return null;
  return s;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
