/**
 * P-001 이메일 매직링크 로그인 — 수용 기준: "토큰은 **해시로만 저장**되고 1회성·TTL 10분·재사용 시 거부".
 * (TTL·1회성·재사용 거부는 DB 상태가 필요하므로 `services/api/test` 가 맡고,
 *  이 파일은 그 전제인 **토큰 자체의 품질**을 못 박는다.)
 *
 * 근거: proplus/CLAUDE.md §5 — "토큰: ≥128bit 랜덤(base64url), DB 에는 SHA-256 해시만, 토큰에 PII 금지".
 * P-002 세션 쿠키 · P-081 조직 초대도 같은 함수를 쓴다.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_BYTES,
  MIN_TOKEN_BYTES,
  constantTimeEqual,
  generateToken,
  hashToken,
} from "../src/token";

/** base64url 문자셋. `+` `/` `=` 가 섞이면 URL·쿠키에서 깨진다. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function byteLength(token: string): number {
  return Buffer.from(token, "base64url").length;
}

describe("P-001 / CLAUDE.md §5: 토큰 엔트로피는 128bit 아래로 내려갈 수 없다", () => {
  it("하한 상수가 128bit(16바이트)이고 기본값은 그보다 크다", () => {
    expect(MIN_TOKEN_BYTES).toBe(16);
    expect(DEFAULT_TOKEN_BYTES).toBeGreaterThanOrEqual(MIN_TOKEN_BYTES);
  });

  it("기본 토큰은 실제로 128bit 이상이다 (base64url 길이·디코딩 바이트 수로 확인)", () => {
    const t = generateToken();
    // 32바이트 → 패딩 없는 base64url 43자. 22자 미만이면 128bit 미달이다.
    expect(t.length).toBe(43);
    expect(t.length).toBeGreaterThanOrEqual(22);
    expect(byteLength(t) * 8).toBeGreaterThanOrEqual(128);
  });

  it("bytes 인자를 주면 그만큼의 엔트로피가 나온다", () => {
    for (const bytes of [16, 24, 32, 64]) {
      const t = generateToken(bytes);
      expect(byteLength(t), `${bytes}바이트 요청`).toBe(bytes);
      expect(t).toMatch(BASE64URL);
    }
  });

  it("base64url 문자셋만 쓴다 — '+' '/' '=' 가 없다", () => {
    for (let i = 0; i < 200; i++) {
      const t = generateToken(16);
      expect(t).toMatch(BASE64URL);
      expect(t).not.toContain("+");
      expect(t).not.toContain("/");
      expect(t).not.toContain("=");
    }
  });

  it("1000회 연속 생성에 중복이 없다 (추측 불가능성의 최소 조건)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateToken());
    expect(seen.size).toBe(1000);
  });

  it("하한 미만·정수 아님·음수 요청은 조용히 깎지 않고 거부한다", () => {
    // "링크를 짧게" 요구가 들어와도 조용히 약해지지 않아야 한다 (보안정책 §2 전수 대입).
    for (const bytes of [15, 8, 1, 0, -1, -32, 16.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => generateToken(bytes), `${bytes} 가 통과했다`).toThrow();
    }
  });

  it("거부 메시지에 근거를 남긴다 (왜 막혔는지 모르면 다시 깎는다)", () => {
    expect(() => generateToken(8)).toThrow(/128bit|16/);
  });
});

describe("P-001: hashToken — DB 에는 해시만 남는다", () => {
  it("sha256 hex 64자를 돌려준다", () => {
    expect(hashToken(generateToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("알고리즘이 sha256 임을 고정한다 (조용히 약한 해시로 바뀌는 것을 막는다)", () => {
    expect(hashToken("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("같은 입력은 같은 해시다 — 그래야 저장된 해시로 대조할 수 있다", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it("생성 토큰과 그 해시는 다른 문자열이다 (평문 저장 사고 방지)", () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h).not.toBe(t);
    expect(h).not.toContain(t);
    expect(t).not.toContain(h);
  });

  it("다른 토큰은 다른 해시가 된다 (1000개 전수)", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) hashes.add(hashToken(generateToken()));
    expect(hashes.size).toBe(1000);
  });

  it("한 글자만 달라도 해시가 완전히 달라진다", () => {
    expect(hashToken("pp_token_sample")).not.toBe(hashToken("pp_token_samplf"));
  });
});

describe("P-001: constantTimeEqual — 대조 경로에서 토큰 길이·내용을 흘리지 않는다", () => {
  it("같은 값은 true 다", () => {
    const t = generateToken();
    expect(constantTimeEqual(t, t)).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("같은 길이에서 한 글자만 달라도 false 다", () => {
    expect(constantTimeEqual("abcdefgh", "abcdefgi")).toBe(false);
    // 첫 글자만 다른 경우도 마지막 글자만 다른 경우와 똑같이 거부된다.
    expect(constantTimeEqual("Xbcdefgh", "abcdefgh")).toBe(false);
  });

  it("길이가 다르면 예외 없이 false 다 (timingSafeEqual 의 길이 예외가 새지 않는다)", () => {
    expect(constantTimeEqual("short", "a-much-longer-token-value")).toBe(false);
    expect(constantTimeEqual("", generateToken())).toBe(false);
    expect(constantTimeEqual(generateToken(16), generateToken(64))).toBe(false);
  });

  it("해시를 토큰으로 착각해 넘기면 통과하지 않는다", () => {
    const t = generateToken();
    expect(constantTimeEqual(t, hashToken(t))).toBe(false);
  });

  it("멀티바이트 문자열에서도 같은 값만 통과한다", () => {
    expect(constantTimeEqual("한글토큰", "한글토큰")).toBe(true);
    expect(constantTimeEqual("한글토큰", "한글토큰x")).toBe(false);
  });
});
