/**
 * P-006 MFA(TOTP) — 코드 생성·검증·복구코드 1회성 (보안정책 §2 / 전략 §7).
 *
 * 정확성의 기준은 우리가 정한 값이 아니라 **RFC 표준 테스트 벡터**다 (RFC 6238 Appendix B).
 * 이 벡터가 맞으면 인증 앱(Google Authenticator 등)과 같은 코드를 낸다는 뜻이다. 깨지면
 * 2단계가 통과만 시키거나 정상 코드를 거부하는 것이고, 둘 다 기능이 없는 것만 못하다.
 */

import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  redeemRecoveryCode,
  totpCode,
  totpCounter,
  verifyTotp,
} from "../src/totp";

/** RFC 6238 Appendix B 의 공유키: ASCII "12345678901234567890" (20바이트, SHA-1). */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

/** RFC 6238 Appendix B (SHA-1) — [유닉스초, 8자리 코드]. */
const RFC_VECTORS: ReadonlyArray<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("P-006: base32 (RFC 4648) — 인증 앱이 읽는 secret 표기", () => {
  it("encode→decode 왕복이 원본 바이트를 보존한다", () => {
    expect(base32Decode(base32Encode(RFC_SECRET)).equals(RFC_SECRET)).toBe(true);
  });

  it("공백·하이픈·소문자를 관용한다 — 사용자가 'abcd efgh'로 붙여 넣어도 같은 값이다", () => {
    const a = base32Decode(RFC_SECRET_B32);
    const b = base32Decode(`  ${RFC_SECRET_B32.toLowerCase().replace(/(.{4})/g, "$1-")}  `);
    expect(a.equals(b)).toBe(true);
  });

  it("알파벳 밖 문자는 던진다 — 오타난 secret 이 '다른 secret'으로 조용히 디코딩되지 않게", () => {
    expect(() => base32Decode("ABC!")).toThrow(/base32/);
  });
});

describe("P-006: HOTP/TOTP — RFC 6238 테스트 벡터와 바이트까지 일치한다", () => {
  it("hotp() 가 8자리 RFC 벡터를 그대로 낸다 (counter = floor(T/30))", () => {
    for (const [t, code] of RFC_VECTORS) {
      const counter = Math.floor(t / 30);
      expect(hotp(RFC_SECRET, counter, 8)).toBe(code);
    }
  });

  it("6자리는 8자리의 하위 6자리와 같다 (HOTP = bin mod 10^digits)", () => {
    for (const [t, code] of RFC_VECTORS) {
      const counter = Math.floor(t / 30);
      expect(hotp(RFC_SECRET, counter, 6)).toBe(code.slice(-6));
    }
  });

  it("totpCode() 는 base32 secret 과 시각으로 같은 벡터를 낸다", () => {
    for (const [t, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET_B32, new Date(t * 1000), { digits: 8 })).toBe(code);
    }
  });

  it("totpCounter 는 유닉스초를 period 로 나눈 몫이다", () => {
    expect(totpCounter(new Date(59 * 1000), 30)).toBe(1);
    expect(totpCounter(new Date(1234567890 * 1000), 30)).toBe(Math.floor(1234567890 / 30));
  });
});

describe("P-006: verifyTotp — 허용 창·자리수·조기반환 없음", () => {
  const AT = new Date(1111111111 * 1000);

  it("현재 스텝의 코드는 통과한다", () => {
    const code = totpCode(RFC_SECRET_B32, AT, { digits: 8 });
    expect(verifyTotp(RFC_SECRET_B32, code, AT, { digits: 8 })).toBe(true);
  });

  it("한 스텝 전(30초 전) 코드는 skew=1 에서 통과한다 — 시계 오차·전송 지연 흡수", () => {
    const prev = totpCode(RFC_SECRET_B32, new Date(AT.getTime() - 30_000), { digits: 8 });
    expect(verifyTotp(RFC_SECRET_B32, prev, AT, { digits: 8, skew: 1 })).toBe(true);
  });

  it("두 스텝 전 코드는 skew=1 에서 거부된다 — 창을 무한정 넓히지 않는다", () => {
    const old = totpCode(RFC_SECRET_B32, new Date(AT.getTime() - 60_000), { digits: 8 });
    expect(verifyTotp(RFC_SECRET_B32, old, AT, { digits: 8, skew: 1 })).toBe(false);
  });

  it("skew=0 이면 인접 스텝도 거부한다", () => {
    const prev = totpCode(RFC_SECRET_B32, new Date(AT.getTime() - 30_000), { digits: 8 });
    expect(verifyTotp(RFC_SECRET_B32, prev, AT, { digits: 8, skew: 0 })).toBe(false);
  });

  it("자리수가 안 맞거나 숫자가 아니면 던지지 않고 false 다", () => {
    expect(verifyTotp(RFC_SECRET_B32, "1234", AT, { digits: 6 })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "abcdef", AT, { digits: 6 })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "", AT)).toBe(false);
  });

  it("깨진 secret 은 던지지 않고 false 다 (검증은 전역적으로 안전하다)", () => {
    expect(verifyTotp("not!base32", "000000", AT)).toBe(false);
  });
});

describe("P-006: generateTotpSecret / otpauthUri — 등록 시 1회 생성·표시", () => {
  it("생성된 secret 은 최소 20바이트로 디코딩된다", () => {
    expect(base32Decode(generateTotpSecret()).length).toBeGreaterThanOrEqual(20);
  });

  it("20바이트 미만은 생성 자체를 막는다", () => {
    expect(() => generateTotpSecret(10)).toThrow(/RFC 4226/);
  });

  it("otpauth URI 가 label·secret·파라미터를 담고 라벨을 인코딩한다", () => {
    const uri = otpauthUri({ secretBase32: RFC_SECRET_B32, account: "a b@ex.test", issuer: "PRO PLUS" });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("PRO%20PLUS:a%20b%40ex.test");
    expect(uri).toContain(`secret=${RFC_SECRET_B32}`);
    expect(uri).toContain("issuer=PRO%20PLUS");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("P-006: 복구 코드 1회성 (수용기준)", () => {
  it("요청 개수만큼 서로 다른 코드를 만든다", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(c))).toBe(true);
  });

  it("해시는 공백·하이픈·대소문자 차이를 무시하고 안정적이다", () => {
    const code = "ABCD-EFGH";
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("abcd efgh"));
    expect(normalizeRecoveryCode(" ab-cd ef ")).toBe("ABCDEF");
  });

  it("제출 코드가 미사용 해시 중 하나와 맞으면 그 해시를 돌려준다", () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    const target = codes[1] as string;
    expect(redeemRecoveryCode(target, hashes)).toBe(hashRecoveryCode(target));
  });

  it("한 번 소진한 코드는 목록에서 빠지면 다시 통하지 않는다 — 1회성", () => {
    const codes = generateRecoveryCodes(3);
    let unused = codes.map(hashRecoveryCode);
    const used = codes[0] as string;
    const matched = redeemRecoveryCode(used, unused);
    expect(matched).not.toBeNull();
    unused = unused.filter((h) => h !== matched); // 호출부가 "사용됨"으로 표시한 뒤
    expect(redeemRecoveryCode(used, unused)).toBeNull();
  });

  it("맞는 게 없거나 빈 제출이면 null 이다", () => {
    const hashes = generateRecoveryCodes(2).map(hashRecoveryCode);
    expect(redeemRecoveryCode("ZZZZ-ZZZZ", hashes)).toBeNull();
    expect(redeemRecoveryCode("", hashes)).toBeNull();
  });
});
