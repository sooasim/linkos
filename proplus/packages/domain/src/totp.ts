/**
 * P-006: MFA(TOTP) 옵션 — 로그인 2단계 + 복구 코드 1회성 (보안정책 §2 "계정 탈취" / 전략 §7 identity).
 *
 * 이 파일은 P-006 의 **순수 핵심**이다 — 코드 생성·검증·복구코드 판정은 전부 결정적 함수라서
 * RFC 표준 테스트 벡터로 정확성을 못 박을 수 있다. 등록(secret 저장·QR 노출)·로그인 2단계
 * 챌린지·복구코드 소진 기록은 DB·세션이 필요한 상위 계층의 몫이고, 그쪽이 이 함수들을 호출한다.
 *
 * 표준을 그대로 따른다:
 *   - HOTP = RFC 4226 (HMAC-SHA1 기반 OTP, 동적 절단)
 *   - TOTP = RFC 6238 (HOTP 의 counter 를 시간 스텝으로)
 *   - secret 표기 = RFC 4648 base32 (인증 앱이 읽는 형식)
 *
 * 왜 도메인에 두는가(전략 §3):
 *   TOTP 검증은 ±시간창 허용·상수시간 비교·자리수 처리에서 조용히 틀리기 쉽다. 틀리면 2단계가
 *   통과만 시키거나(보안 0) 정상 코드를 거부한다(가용성 0). 순수 함수로 떼어 내 **전수 벡터로**
 *   고정하는 것이 유일하게 믿을 수 있는 방법이다. `node:crypto` 는 계산이라 I/O 금지에 걸리지 않는다
 *   (`token.ts`·`ssoAssertion.ts` 와 같은 전례).
 *
 * `now: Date` 를 인자로 받는 이유: 도메인은 `Date.now()` 를 쓰지 않는다(§3). 시간 의존 코드는
 * 테스트가 시각을 고정할 수 있어야 벡터 검증이 가능하다.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constantTimeEqual, hashToken } from "./token";

/** 인증 앱이 쓰는 기본값. 바꾸면 provisioning URI 와 검증이 함께 바뀌어야 한다(여기 한 곳에서 고정한다). */
export const TOTP_DEFAULT_DIGITS = 6;
export const TOTP_DEFAULT_PERIOD = 30; // 초
/** 검증 시 앞뒤로 허용하는 스텝 수. 1 이면 ±30초(시계 오차·전송 지연 흡수). 더 넓히면 유출 창이 커진다. */
export const TOTP_DEFAULT_SKEW = 1;
/** RFC 4226 권장 공유키 길이(SHA-1 블록). 160bit 미만은 생성 자체를 막는다. */
export const TOTP_SECRET_BYTES = 20;

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}

// ─────────────────────────────────────────────────────────────────────────────
// base32 (RFC 4648) — 인증 앱이 읽고 쓰는 secret 표기
// ─────────────────────────────────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * base32 문자열을 바이트로 되돌린다. 공백·하이픈·패딩(`=`)은 버리고 대문자로 접는다 —
 * 인증 앱마다 secret 을 공백으로 끊어 보여 주므로 사용자가 그대로 붙여 넣어도 동작해야 한다.
 *
 * 알파벳 밖 문자가 있으면 던진다: 조용히 건너뛰면 오타난 secret 이 "다른 secret"으로 디코딩돼
 * 영영 통과하지 않는 2단계가 된다 — 원인을 못 찾는 종류의 고장이다.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
  if (clean.length === 0) return Buffer.alloc(0);

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base32 가 아닌 문자: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** 바이트를 base32 문자열로. 새 secret 을 만들어 사용자·QR 에 보여 줄 때 쓴다(패딩은 생략한다). */
export function base32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

/** 새 TOTP 공유키를 base32 로 만든다. 등록 시 한 번 생성해 저장·QR 에 쓴다. */
export function generateTotpSecret(bytes: number = TOTP_SECRET_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < TOTP_SECRET_BYTES) {
    throw new Error(`TOTP secret 은 최소 ${TOTP_SECRET_BYTES}바이트여야 한다 (RFC 4226 §4)`);
  }
  return base32Encode(randomBytes(bytes));
}

// ─────────────────────────────────────────────────────────────────────────────
// HOTP (RFC 4226) / TOTP (RFC 6238)
// ─────────────────────────────────────────────────────────────────────────────

function hmacAlgo(a: TotpAlgorithm): string {
  return a === "SHA256" ? "sha256" : a === "SHA512" ? "sha512" : "sha1";
}

/**
 * RFC 4226 §5.3 동적 절단. counter 는 8바이트 big-endian 이다 — 큰 시간 스텝도 넘치지 않게
 * BigInt 로 쓴다(32bit 로 자르면 2038 이후가 아니라 당장의 큰 벡터부터 틀린다).
 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DEFAULT_DIGITS, algorithm: TotpAlgorithm = "SHA1"): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(counter)));
  const mac = createHmac(hmacAlgo(algorithm), secret).update(buf).digest();

  // 마지막 바이트의 하위 4비트가 오프셋. 그 지점부터 4바이트를 31비트 정수로 읽는다.
  const last = mac[mac.length - 1];
  if (last === undefined) throw new Error("HMAC 결과가 비었다");
  const offset = last & 0x0f;
  const b0 = mac[offset];
  const b1 = mac[offset + 1];
  const b2 = mac[offset + 2];
  const b3 = mac[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error("HMAC 절단 범위를 벗어났다");
  }
  const bin = ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, "0");
}

/** 시각을 시간 스텝(counter)으로. RFC 6238 §4.2: floor(unixSeconds / period). */
export function totpCounter(now: Date, period: number = TOTP_DEFAULT_PERIOD): number {
  return Math.floor(now.getTime() / 1000 / period);
}

/** 주어진 시각의 TOTP 코드. secret 은 base32 문자열(저장·표시 형식)로 받는다. */
export function totpCode(secretBase32: string, now: Date, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? TOTP_DEFAULT_DIGITS;
  const period = opts.period ?? TOTP_DEFAULT_PERIOD;
  const algorithm = opts.algorithm ?? "SHA1";
  return hotp(base32Decode(secretBase32), totpCounter(now, period), digits, algorithm);
}

/**
 * 제출된 코드가 현재 시각 기준 허용 창 안의 어느 스텝과 일치하는지 검증한다.
 *
 * 설계상 **절대 던지지 않는다** — 자리수가 안 맞거나 숫자가 아니면 `false` 다. 검증 함수가
 * 던지면 호출부가 try/catch 를 잊는 순간 2단계가 열린다.
 *
 * 창 전체를 끝까지 돈다(일치해도 조기 반환하지 않는다): 어느 스텝에서 맞았는지가 응답 시간으로
 * 새어 나가면 공격자가 서버 시계를 역산할 수 있다(미미하지만 `token.ts` 의 상수시간 원칙과 맞춘다).
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  now: Date,
  opts: TotpOptions & { skew?: number } = {},
): boolean {
  const digits = opts.digits ?? TOTP_DEFAULT_DIGITS;
  const period = opts.period ?? TOTP_DEFAULT_PERIOD;
  const algorithm = opts.algorithm ?? "SHA1";
  const skew = opts.skew ?? TOTP_DEFAULT_SKEW;

  const presented = typeof token === "string" ? token.replace(/\s/g, "") : "";
  if (presented.length !== digits || !/^\d+$/.test(presented)) return false;

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (secret.length === 0) return false;

  const center = totpCounter(now, period);
  let matched = false;
  for (let d = -skew; d <= skew; d++) {
    const candidate = hotp(secret, center + d, digits, algorithm);
    // 길이가 같으므로 바이트 비교. 조기 반환 없이 OR 로 누적한다.
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(presented))) matched = true;
  }
  return matched;
}

/**
 * 인증 앱에 넣을 provisioning URI (otpauth://). QR 로 보여 주는 값이다.
 *
 * Google Authenticator Key URI 형식을 따른다. label(`issuer:account`)은 경로라서 각 조각을
 * 인코딩하고, secret·issuer 는 쿼리라서 한 번 더 인코딩한다 — 조직명/이메일에 공백·`@`·`:` 가
 * 들어와도 깨지지 않게.
 */
export function otpauthUri(params: {
  secretBase32: string;
  account: string;
  issuer: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const digits = params.digits ?? TOTP_DEFAULT_DIGITS;
  const period = params.period ?? TOTP_DEFAULT_PERIOD;
  const algorithm = params.algorithm ?? "SHA1";
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = [
    `secret=${encodeURIComponent(params.secretBase32.replace(/[\s-]/g, "").toUpperCase())}`,
    `issuer=${encodeURIComponent(params.issuer)}`,
    `algorithm=${algorithm}`,
    `digits=${digits}`,
    `period=${period}`,
  ].join("&");
  return `otpauth://totp/${label}?${query}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 복구 코드 — "활성화 시 복구 코드 1회성" (P-006 수용기준)
// ─────────────────────────────────────────────────────────────────────────────

/** 기본 복구 코드 수·형식. 8자 base32 두 묶음("ABCD-EFGH") = 40bit, 1회성이라 이 정도면 충분하다. */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_GROUP_LEN = 4;
const RECOVERY_GROUPS = 2;

/**
 * 1회성 복구 코드 묶음을 만든다. **평문은 여기서 한 번만** 사용자에게 보여 주고, 저장은
 * `hashRecoveryCode()` 의 해시로만 한다(토큰과 같은 규칙 — 평문은 DB·백업에 남기지 않는다).
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const n = Number.isInteger(count) && count > 0 ? count : RECOVERY_CODE_COUNT;
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < n) {
    const raw = base32Encode(randomBytes(RECOVERY_GROUP_LEN * RECOVERY_GROUPS)).slice(0, RECOVERY_GROUP_LEN * RECOVERY_GROUPS);
    const groups: string[] = [];
    for (let i = 0; i < RECOVERY_GROUPS; i++) groups.push(raw.slice(i * RECOVERY_GROUP_LEN, (i + 1) * RECOVERY_GROUP_LEN));
    const formatted = groups.join("-");
    // 희박하지만 중복이 나오면 버린다 — 같은 코드가 둘이면 "1회성"이 흔들린다.
    if (seen.has(formatted)) continue;
    seen.add(formatted);
    codes.push(formatted);
  }
  return codes;
}

/** 비교·해시 전에 형식 차이를 없앤다. 공백·하이픈 제거 + 대문자 — 사용자가 "abcd efgh"로 쳐도 맞게. */
export function normalizeRecoveryCode(raw: string): string {
  return typeof raw === "string" ? raw.replace(/[\s-]/g, "").toUpperCase() : "";
}

/** 저장용 해시. 평문 복구 코드는 토큰과 같은 이유로 저장하지 않는다(`token.ts` hashToken 재사용). */
export function hashRecoveryCode(raw: string): string {
  return hashToken(normalizeRecoveryCode(raw));
}

/**
 * 제출된 복구 코드가 **아직 쓰지 않은** 해시 목록 중 하나와 일치하는지 본다.
 *
 * 반환값은 일치한 **해시**다(또는 null) — 호출부가 그 해시를 "사용됨"으로 표시해 1회성을 완성한다.
 * 도메인은 상태를 바꾸지 못하므로(§3), "어느 것을 소진하라"까지만 알려 준다.
 *
 * 목록 전체를 끝까지 상수시간으로 돈다: 몇 번째에서 맞았는지를 타이밍으로 흘리지 않는다.
 */
export function redeemRecoveryCode(presentedRaw: string, unusedHashes: readonly string[]): string | null {
  const presentedHash = hashRecoveryCode(presentedRaw);
  let matched: string | null = null;
  for (const h of unusedHashes) {
    if (typeof h === "string" && constantTimeEqual(presentedHash, h)) matched = h;
  }
  // 빈 제출이 빈 해시와 우연히 맞는 일은 없다: 빈 코드도 해시는 비어 있지 않다. 그래도 방어적으로 막는다.
  return normalizeRecoveryCode(presentedRaw).length > 0 ? matched : null;
}
