// F-052 오프라인 큐: 네트워크가 없을 때 앱↔앱 교환을 기기에 서명된 영수증으로 보관하고, 재연결 시 서버가 검증 후
// 멱등하게 관계를 만든다. 서명 키는 기기별(per-device) HMAC 키로, 온라인일 때 서버에 등록된다.
//
//  - OfflinePass  (보내는 사람 기기 서명): "나는 이 계정의 이 카드로 교환에 동의한다" — 받는 앱이 스캔.
//  - OfflineReceipt (받는 사람 기기 서명): "이 pass 를 이 시각에 받았다" — 재연결 시 서버로 업로드.
//
// 서명은 전송된 문자열 그대로에 대해 계산한다(정규화 불일치 방지). Pure — no I/O.
import { fromBase64Url, hmacSha256Base64Url, toBase64Url, utf8 } from "./hmac";
import { constantTimeEqual } from "./token";

export const OFFLINE_PASS_PREFIX = "LKP1";
export const OFFLINE_RECEIPT_PREFIX = "LKR1";
/** A pass is valid for at most 24h after issue. */
export const OFFLINE_PASS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Receipts older than this are rejected on sync. */
export const OFFLINE_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Allowed device clock skew. */
export const OFFLINE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface OfflinePassClaims {
  v: 1;
  /** sender device key id */
  k: string;
  /** sender user id */
  u: string;
  /** sender profile id */
  p: string;
  /** display name for the receiver's local preview only (the server re-reads the card) */
  n: string;
  iat: number;
  exp: number;
  /** random nonce */
  r: string;
}

export interface OfflineReceiptClaims {
  v: 1;
  /** client-generated receipt id (uuid) — idempotency key together with k */
  id: string;
  /** receiver device key id */
  k: string;
  /** the scanned sender pass, verbatim */
  pass: string;
  /** when the exchange happened (ms epoch, device clock) */
  at: number;
  /** receiver also shares their own card back (mutual exchange) */
  rc: boolean;
  pl?: string;
}

export function decodeSecret(secretB64: string): Uint8Array {
  const b = fromBase64Url(secretB64);
  if (!b || b.length < 32) throw new Error("device secret must be >= 256 bits");
  return b;
}

function b64json(obj: unknown): string {
  return toBase64Url(utf8(JSON.stringify(obj)));
}

function parseB64Json<T>(s: string): T | null {
  const bytes = fromBase64Url(s);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export function signOfflinePass(claims: OfflinePassClaims, secretB64: string): string {
  if (claims.exp - claims.iat > OFFLINE_PASS_MAX_TTL_MS) throw new Error("pass ttl too long");
  const body = `${OFFLINE_PASS_PREFIX}.${b64json(claims)}`;
  return `${body}.${hmacSha256Base64Url(decodeSecret(secretB64), body)}`;
}

/** Parse without verifying (to look up the key id). Returns null for malformed input. */
export function parseOfflinePass(pass: string): { claims: OfflinePassClaims; body: string; sig: string } | null {
  if (pass.length > 2048) return null;
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== OFFLINE_PASS_PREFIX) return null;
  const claims = parseB64Json<OfflinePassClaims>(parts[1]!);
  if (!claims || claims.v !== 1 || typeof claims.k !== "string" || typeof claims.u !== "string" || typeof claims.p !== "string") return null;
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number" || typeof claims.n !== "string") return null;
  return { claims, body: `${parts[0]}.${parts[1]}`, sig: parts[2]! };
}

export function verifyOfflinePass(pass: string, secretB64: string): OfflinePassClaims | null {
  const p = parseOfflinePass(pass);
  if (!p) return null;
  const expected = hmacSha256Base64Url(decodeSecret(secretB64), p.body);
  if (!constantTimeEqual(expected, p.sig)) return null;
  if (p.claims.exp - p.claims.iat > OFFLINE_PASS_MAX_TTL_MS || p.claims.exp < p.claims.iat) return null;
  return p.claims;
}

export interface SignedReceipt {
  payload: string;
  signature: string;
}

export function signOfflineReceipt(claims: OfflineReceiptClaims, secretB64: string): SignedReceipt {
  const payload = `${OFFLINE_RECEIPT_PREFIX}.${b64json(claims)}`;
  return { payload, signature: hmacSha256Base64Url(decodeSecret(secretB64), payload) };
}

export function parseOfflineReceipt(payload: string): OfflineReceiptClaims | null {
  if (payload.length > 4096) return null;
  const [prefix, body, ...rest] = payload.split(".");
  if (prefix !== OFFLINE_RECEIPT_PREFIX || !body || rest.length) return null;
  const c = parseB64Json<OfflineReceiptClaims>(body);
  if (!c || c.v !== 1 || typeof c.id !== "string" || typeof c.k !== "string" || typeof c.pass !== "string" || typeof c.at !== "number" || typeof c.rc !== "boolean") return null;
  if (!/^[0-9a-f-]{36}$/i.test(c.id)) return null;
  return c;
}

export function verifyOfflineReceiptSignature(r: SignedReceipt, secretB64: string): boolean {
  return constantTimeEqual(hmacSha256Base64Url(decodeSecret(secretB64), r.payload), r.signature);
}

export type ReceiptRejection = "pass_expired" | "pass_not_yet_valid" | "receipt_in_future" | "receipt_too_old" | "self_exchange";

/** Time-window rules shared by the app (pre-check) and the server (authoritative). */
export function checkReceiptWindow(receipt: OfflineReceiptClaims, pass: OfflinePassClaims, receiverUserId: string, now = Date.now()): ReceiptRejection | null {
  if (pass.u === receiverUserId) return "self_exchange";
  if (receipt.at > now + OFFLINE_CLOCK_SKEW_MS) return "receipt_in_future";
  if (now - receipt.at > OFFLINE_RECEIPT_MAX_AGE_MS) return "receipt_too_old";
  if (receipt.at < pass.iat - OFFLINE_CLOCK_SKEW_MS) return "pass_not_yet_valid";
  if (receipt.at > pass.exp + OFFLINE_CLOCK_SKEW_MS) return "pass_expired";
  return null;
}
