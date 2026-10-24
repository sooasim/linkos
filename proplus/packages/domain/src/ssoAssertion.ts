/**
 * LINKOS → PROPLUS 단일 로그인 assertion — 서명과 검증 (연동 ①).
 *
 * 근거: `proplus/docs/05_LINKOS_INTEGRATION.md` §1 "assertion 형식" + "검증 규칙(전부 필수)"
 *       ADR-012: 두 제품은 **HTTP 계약으로만** 오간다 — 공유 DB·공유 패키지가 없다.
 *
 * ## 왜 JWT 라이브러리가 아닌가
 *
 * 필요한 것은 "이 브라우저의 LINKOS 사용자가 누구인지"를 **한 번** 전달하는 것뿐이다(05 §1).
 * 같은 운영자의 1st-party 앱 두 개 사이라 동의 화면·스코프·리프레시 토큰이 없고, 그래서
 * alg 협상·JWK 회전도 없다. 형식을 `v1` 하나로 못 박고 HMAC-SHA256 만 쓰면 틀릴 구석이 줄어든다 —
 * 특히 **alg 를 토큰에서 읽지 않으므로** "alg: none" 류의 혼란이 애초에 성립하지 않는다.
 *
 * ## 왜 도메인 패키지인가
 *
 * 이 파일의 가치는 통과 경로가 아니라 **거부 경로**에 있다. 순수 함수여야 거부를 전수 테스트할 수
 * 있으므로 `now` 를 인자로 받고(전략 §3: 도메인은 `Date.now()` 금지) secret 도 호출부가 주입한다
 * (도메인은 `process.env` 를 읽지 않는다).
 *
 * ## HMAC 의 입력은 **디코딩된 payload 바이트**다
 *
 * 05 §1 의 `hmac-sha256(payload, SSO_SHARED_SECRET)` 를 글자대로 읽은 것이고, 그게 실제로도
 * 안전한 쪽이다: 검증이 JSON 을 **재직렬화하지 않으므로** LINKOS 발급자가 어떤 직렬화기를 쓰든
 * (키 순서·공백·유니코드 이스케이프가 달라도) 서명이 깨지지 않는다. 재직렬화해서 비교하는 설계는
 * 양쪽이 "표준 JSON" 에 합의해야 하고, 그 합의는 언젠가 조용히 어긋난다.
 */

import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SsoPayload {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string | null;
  jti: string;
  iat: number;
  exp: number;
}

/** 형식 버전. 접두사가 다르면 서명 검사 **이전에** 거부한다 (05 §1 검증규칙 1). */
export const SSO_ASSERTION_VERSION = "v1";

/** 05 §1: `iss` 는 고정값이다. */
export const SSO_ISSUER = "linkos";

/** 05 §1: `aud` 고정 — 다른 앱이 이 토큰을 재사용할 수 없게 하는 장치다. */
export const SSO_AUDIENCE = "proplus";

/** 05 §1 검증규칙 4: `iat <= now + 30s`. 두 서버의 시계 오차 허용분이다. */
export const SSO_CLOCK_SKEW_SEC = 30;

/** 05 §1 비밀값: 32바이트 이상. 이 아래면 서명이 아니라 **설정 오류**로 거부한다. */
export const SSO_SECRET_MIN_BYTES = 32;

/**
 * 토큰 길이 상한. 서명 검사 전에 자르는 값이라 넉넉하게 둔다 —
 * 상한이 없으면 거대한 base64 를 HMAC·JSON.parse 로 흘려보내는 값싼 CPU 공격이 열린다.
 */
export const SSO_ASSERTION_MAX_LEN = 4096;

/** 이메일 길이 상한 (RFC 5321). 형식 판정은 하지 않는다 — 아래 `verifyAssertion` 주석 참조. */
const EMAIL_MAX_LEN = 254;

export type SsoRejectCode =
  /** 접두사·세그먼트 개수·base64url·JSON 구조가 깨졌다. */
  | "malformed"
  /** 호출부 설정 오류: 공유 비밀값이 없거나 32바이트보다 짧다. */
  | "bad_secret"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "iat_in_future"
  | "email_missing";

export type SsoVerifyResult =
  | { ok: true; payload: SsoPayload }
  | { ok: false; code: SsoRejectCode; message: string };

export interface SsoVerifyOptions {
  expectedIss?: string;
  expectedAud?: string;
}

/** base64url 알파벳만. `Buffer.from(s, "base64url")` 는 쓰레기 입력을 조용히 삼키므로 먼저 막는다. */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function reject(code: SsoRejectCode, message: string): SsoVerifyResult {
  return { ok: false, code, message };
}

function secretTooShort(secret: string): boolean {
  return typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < SSO_SECRET_MIN_BYTES;
}

function hmac(payloadBytes: Buffer, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadBytes).digest();
}

/**
 * 상수시간 비교. **길이가 달라도 안전해야 한다** —
 * `timingSafeEqual` 은 길이가 다르면 예외를 던지고, 길이를 먼저 분기해 조기 반환하면
 * 그 분기 자체가 "서명 길이가 맞는지"를 흘린다. 그래서 양쪽을 한 번 더 SHA-256 으로 접어
 * **항상 32바이트**로 맞춘 뒤 비교한다 (`domain/token.ts` 의 `constantTimeEqual` 과 같은 방식).
 */
function constantTimeEqualBytes(a: Buffer, b: Buffer): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * assertion 을 만든다 — 테스트와 **LINKOS 쪽 발급자의 참조 구현**을 위한 함수다.
 *
 * PROPLUS 런타임은 이 함수를 쓰지 않는다(PROPLUS 는 검증만 한다). 그래도 같은 파일에 두는 이유:
 * 서명 입력이 무엇인지(디코딩된 payload 바이트)를 글로만 적어 두면 양쪽 구현이 어긋나고,
 * 그 어긋남은 "로그인이 전부 서명 불일치" 라는 형태로만 드러난다. 발급과 검증을 같은 파일에서
 * 라운드트립 테스트로 묶어 두는 것이 그 사고를 막는 유일한 수단이다.
 */
export function signAssertion(p: SsoPayload, secret: string): string {
  if (secretTooShort(secret)) {
    throw new Error(`SSO_SHARED_SECRET 은 ${SSO_SECRET_MIN_BYTES}바이트 이상이어야 한다 (05_LINKOS_INTEGRATION §1 비밀값)`);
  }
  const bytes = Buffer.from(JSON.stringify(p), "utf8");
  return [SSO_ASSERTION_VERSION, bytes.toString("base64url"), hmac(bytes, secret).toString("base64url")].join(".");
}

/**
 * 05 §1 의 검증 규칙을 **순서대로** 적용한다.
 *
 * 순서가 설계의 일부다: 구조 → 서명 → 클레임. 서명을 확인하기 전에는 payload 의 어떤 값도
 * 믿지 않는다(그 값으로 분기하면 서명 없는 입력이 동작을 바꾼다). 그래서 `iss` 확인조차
 * HMAC 뒤에 있다.
 *
 * **`jti` 는 형식만 본다.** 1회성(재생 공격 차단)은 이 함수가 보장할 수 없다 — 순수 함수는
 * "이미 썼는지"를 알 수 없고, 알 수 있게 만들면 그건 I/O 다. 실제 차단은
 * `sso_assertions.jti` 의 UNIQUE 제약이 한다 (0003 마이그레이션 · 05 §1 검증규칙 5).
 * 애플리케이션 선조회로 막지 않는 이유도 같다: 동시 요청 두 개를 못 막는다.
 *
 * 이메일도 **형식 판정을 하지 않는다**(존재와 길이만 본다). 05 §1 규칙 6은 "`email` 이 있을 것"
 * 이고, 여기서 PROPLUS 의 이메일 정규식을 한 번 더 적용하면 LINKOS 가 받아들인 정상 주소를
 * PROPLUS 가 거절하는 틈이 생긴다. 접기(NFKC·소문자)와 계정 연결은 모듈 계층의 일이다.
 */
export function verifyAssertion(
  token: string,
  secret: string,
  now: Date,
  opts: SsoVerifyOptions = {},
): SsoVerifyResult {
  // 설정 오류를 "서명 불일치"로 숨기면 운영에서 원인을 찾을 수 없다. 코드를 따로 둔다
  // (라우트는 이 코드를 사용자에게 그대로 보여 주지 않는다 — 503 으로 접는다).
  if (secretTooShort(secret)) {
    return reject("bad_secret", "SSO 공유 비밀값이 설정되지 않았거나 너무 짧습니다.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    // fail-closed: 시각을 모르면 만료를 판정할 수 없으므로 통과시키지 않는다.
    return reject("malformed", "서버 시각을 확인할 수 없습니다.");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > SSO_ASSERTION_MAX_LEN) {
    return reject("malformed", "로그인 토큰이 올바르지 않습니다.");
  }

  const parts = token.split(".");
  if (parts.length !== 3) return reject("malformed", "로그인 토큰이 올바르지 않습니다.");
  const [version, payloadSeg, sigSeg] = parts;
  if (version !== SSO_ASSERTION_VERSION) {
    return reject("malformed", "지원하지 않는 로그인 토큰 형식입니다.");
  }
  if (!payloadSeg || !sigSeg || !B64URL_RE.test(payloadSeg) || !B64URL_RE.test(sigSeg)) {
    return reject("malformed", "로그인 토큰이 올바르지 않습니다.");
  }

  const payloadBytes = Buffer.from(payloadSeg, "base64url");
  if (payloadBytes.length === 0) return reject("malformed", "로그인 토큰이 올바르지 않습니다.");

  // 05 §1 검증규칙 2. 여기를 통과한 뒤부터만 payload 를 믿는다.
  if (!constantTimeEqualBytes(hmac(payloadBytes, secret), Buffer.from(sigSeg, "base64url"))) {
    return reject("bad_signature", "로그인 토큰의 서명이 올바르지 않습니다.");
  }

  const claims = parseClaims(payloadBytes);
  if (!claims) return reject("malformed", "로그인 토큰의 내용을 읽을 수 없습니다.");

  // 05 §1 검증규칙 3. 기본값은 고정 상수이고, opts 는 테스트·스테이징에서만 바꾼다.
  if (claims.iss !== (opts.expectedIss ?? SSO_ISSUER)) {
    return reject("bad_issuer", "로그인 토큰의 발급자가 올바르지 않습니다.");
  }
  if (claims.aud !== (opts.expectedAud ?? SSO_AUDIENCE)) {
    return reject("bad_audience", "이 로그인 토큰은 PROPLUS 용이 아닙니다.");
  }

  // 05 §1 검증규칙 4. `exp > now` 이므로 **경계(exp === now)는 만료**다 — 60초 창에서
  // 1초를 더 봐주는 것이 얻는 것은 없고, "같으면 통과"는 리뷰어가 매번 다시 확인해야 하는 모호함이다.
  const nowSec = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSec) {
    return reject("expired", "로그인 요청이 만료되었습니다. 다시 로그인해 주세요.");
  }
  if (claims.iat > nowSec + SSO_CLOCK_SKEW_SEC) {
    return reject("iat_in_future", "로그인 요청의 발급 시각이 올바르지 않습니다.");
  }

  // 05 §1 검증규칙 6: PROPLUS 는 이메일로 계정을 잇는다. 없으면 이을 대상이 없다.
  if (claims.email.trim().length === 0 || claims.email.length > EMAIL_MAX_LEN) {
    return reject("email_missing", "LINKOS 계정에 이메일이 없어 PROPLUS 계정을 연결할 수 없습니다.");
  }

  return { ok: true, payload: claims };
}

/**
 * 서명이 확인된 바이트를 `SsoPayload` 로 접는다. 타입이 틀린 필드는 **보정하지 않고 거부**한다 —
 * `Number(exp)` 같은 보정은 `exp: "0"` 을 조용히 만료 0초로 만들 수 있다.
 *
 * `name` 만 예외적으로 관대하다: 없으면 `null` 이다. 표시 이름은 로그인 성립에 필요한 사실이 아니고,
 * LINKOS 쪽에서 비어 있는 것이 정상인 값이다.
 */
function parseClaims(payloadBytes: Buffer): SsoPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const iss = str(o.iss);
  const aud = str(o.aud);
  const sub = str(o.sub);
  const email = str(o.email);
  const jti = str(o.jti);
  if (iss === null || aud === null || sub === null || email === null || jti === null) return null;
  // sub·jti 가 빈 문자열이면 "누구인지"와 "어느 요청인지"를 가리키지 못한다. 재생 방지 키가 비는 것도 막는다.
  if (sub.trim().length === 0 || jti.trim().length === 0) return null;

  if (!Number.isSafeInteger(o.iat) || !Number.isSafeInteger(o.exp)) return null;
  const iat = o.iat as number;
  const exp = o.exp as number;

  const nameRaw = o.name;
  if (nameRaw !== undefined && nameRaw !== null && typeof nameRaw !== "string") return null;
  const name = typeof nameRaw === "string" ? nameRaw : null;

  return { iss, aud, sub, email, name, jti, iat, exp };
}
