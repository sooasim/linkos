/**
 * 05_LINKOS_INTEGRATION §3 — 이메일 해시 디렉터리 조회의 입력 규칙.
 *
 * 여기서 지키는 것은 "해시 입력" 겹이다(§3 의 세 겹 중 두 번째). 이 겹이 약해지는 방식은 세 가지뿐이고
 * 전부 조용하다: (a) 정규화가 어긋나 아무것도 매칭되지 않는다, (b) 솔트가 빠져 공개 사전으로 역상이 된다,
 * (c) 상한이 무의미해져 대량 수집이 가능해진다. 그래서 그 셋을 테스트가 못 박는다.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_LOOKUP_HASHES,
  emailLookupHash,
  isLookupHash,
  validateLookupRequest,
} from "../src/directory";

const SALT = "pp-directory-salt-0001";
const OTHER_SALT = "pp-directory-salt-0002";

describe("05 §3: emailLookupHash 는 양쪽이 같은 값을 만드는 유일한 공식이다", () => {
  it("sha256 hex(소문자 64자) 를 돌려준다", () => {
    const h = emailLookupHash("kim@example.com", SALT);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(isLookupHash(h)).toBe(true);
  });

  it("같은 입력은 항상 같은 해시다 (결정적 — 그래야 대조가 성립한다)", () => {
    expect(emailLookupHash("kim@example.com", SALT)).toBe(emailLookupHash("kim@example.com", SALT));
  });

  it("대문자·앞뒤 공백·전체 대문자 표기가 모두 같은 해시로 접힌다", () => {
    const base = emailLookupHash("kim@example.com", SALT);
    for (const variant of ["KIM@EXAMPLE.COM", "  kim@example.com  ", "Kim@Example.Com", "\tkim@example.com\n"]) {
      expect(emailLookupHash(variant, SALT), variant).toBe(base);
    }
  });

  it("다른 이메일은 다른 해시다", () => {
    expect(emailLookupHash("kim@example.com", SALT)).not.toBe(emailLookupHash("lee@example.com", SALT));
  });

  it("솔트가 다르면 해시가 다르다 — 양쪽 env 가 어긋나면 매칭이 0 이어야 한다", () => {
    expect(emailLookupHash("kim@example.com", SALT)).not.toBe(emailLookupHash("kim@example.com", OTHER_SALT));
  });

  it("솔트가 비면 던진다 (조용히 공개 sha256(email) 이 되지 않는다)", () => {
    expect(() => emailLookupHash("kim@example.com", "")).toThrow(/DIRECTORY_SALT/);
  });

  it("이메일이 비면 던진다 — 솔트만 해시한 값이 '어떤 사용자'를 가리키면 안 된다", () => {
    expect(() => emailLookupHash("", SALT)).toThrow();
    expect(() => emailLookupHash("   ", SALT)).toThrow();
  });

  it("해시 안에 평문이 남지 않는다 (N-13: 로그·요청에 이메일 원문 금지)", () => {
    const h = emailLookupHash("kim@example.com", SALT);
    expect(h).not.toContain("kim");
    expect(h).not.toContain("@");
  });
});

describe("05 §3: isLookupHash 는 sha256 hex 만 통과시킨다", () => {
  it("소문자 64자 hex 만 참이다", () => {
    expect(isLookupHash("a".repeat(64))).toBe(true);
    expect(isLookupHash("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("길이·문자셋·타입이 어긋나면 거짓이다", () => {
    const bad: unknown[] = [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64), // 대문자 hex 는 교정 대상이지 통과 대상이 아니다
      `${"a".repeat(63)}g`,
      "kim@example.com",
      "",
      null,
      undefined,
      123,
      { hash: "a".repeat(64) },
      ["a".repeat(64)],
    ];
    for (const v of bad) expect(isLookupHash(v), JSON.stringify(v)).toBe(false);
  });
});

describe("05 §3: validateLookupRequest", () => {
  const h = (n: number) => String(n).padStart(64, "0");

  it("정상 본문을 통과시킨다", () => {
    const out = validateLookupRequest({ emailHashes: [h(1), h(2)] });
    expect(out).toEqual({ ok: true, hashes: [h(1), h(2)] });
  });

  it("객체가 아니면 거부한다", () => {
    for (const body of [null, undefined, "x", 1, [h(1)]]) {
      const out = validateLookupRequest(body);
      expect(out.ok, JSON.stringify(body)).toBe(false);
      if (!out.ok) expect(out.code).toBe("invalid_body");
    }
  });

  it("빈 배열·누락·배열 아님을 거부한다", () => {
    for (const body of [{}, { emailHashes: [] }, { emailHashes: h(1) }, { emailHashes: {} }]) {
      const out = validateLookupRequest(body);
      expect(out.ok, JSON.stringify(body)).toBe(false);
      if (!out.ok) expect(out.code).toBe("email_hashes_required");
    }
  });

  it(`${MAX_LOOKUP_HASHES}개까지 받고 그 위는 거부한다`, () => {
    const many = Array.from({ length: MAX_LOOKUP_HASHES }, (_, i) => h(i));
    expect(validateLookupRequest({ emailHashes: many }).ok).toBe(true);

    const tooMany = Array.from({ length: MAX_LOOKUP_HASHES + 1 }, (_, i) => h(i));
    const out = validateLookupRequest({ emailHashes: tooMany });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("too_many_hashes");
  });

  it("중복으로 상한을 우회할 수 없다 — 개수는 중복 제거 전에 센다", () => {
    const dup = Array.from({ length: MAX_LOOKUP_HASHES + 1 }, () => h(7));
    const out = validateLookupRequest({ emailHashes: dup });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("too_many_hashes");
  });

  it("중복을 제거하고 입력 순서를 유지한다", () => {
    const out = validateLookupRequest({ emailHashes: [h(2), h(1), h(2), h(3), h(1)] });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.hashes).toEqual([h(2), h(1), h(3)]);
  });

  it("공백·대문자 hex 는 교정해서 통과시킨다", () => {
    const out = validateLookupRequest({ emailHashes: [`  ${"AB".repeat(32)}  `] });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.hashes).toEqual(["ab".repeat(32)]);
  });

  it("해시 형식이 아닌 값은 전부 거부한다 (평문 이메일이 서버 로그에 들어오지 않게)", () => {
    for (const bad of [["kim@example.com"], [h(1), "nope"], [123], [null], [["nested"]], ["a".repeat(63)]]) {
      const out = validateLookupRequest({ emailHashes: bad });
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      if (!out.ok) expect(out.code).toBe("invalid_email_hash");
    }
  });

  it("에러 메시지에 조회 대상 값을 되비추지 않는다", () => {
    const out = validateLookupRequest({ emailHashes: ["kim@example.com"] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).not.toContain("kim@example.com");
  });
});
