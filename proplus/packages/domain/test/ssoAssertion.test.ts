/**
 * LINKOS SSO assertion 검증 — 05_LINKOS_INTEGRATION §1 "검증 규칙(전부 필수)" 6개.
 *
 * 이 테스트의 무게는 통과 경로가 아니라 **거부 경로**에 있다. 그게 이 함수의 존재 이유다:
 * 통과는 한 가지 모양이고, 틀리는 방법은 여러 가지인데 전부 "로그인이 된다" 로 끝난다.
 *
 * `signRaw()` 를 테스트가 **직접** 구현하는 것이 의도다. `signAssertion()` 으로만 토큰을 만들면
 * 두 함수가 같이 틀려도 테스트가 통과한다(같은 버그를 서로 확인해 준다). 와이어 형식
 * (`v1.<b64url(payload JSON)>.<b64url(hmac-sha256(payload bytes))>`)을 테스트가 독립적으로
 * 적어 두면, LINKOS 쪽 발급자가 이 형식에서 벗어났을 때 여기서 먼저 깨진다.
 */

import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SSO_ASSERTION_MAX_LEN,
  SSO_AUDIENCE,
  SSO_CLOCK_SKEW_SEC,
  SSO_ISSUER,
  SSO_SECRET_MIN_BYTES,
  type SsoPayload,
  signAssertion,
  verifyAssertion,
} from "../src/ssoAssertion";

/** 32바이트 이상 (05 §1 비밀값). */
const SECRET = "proplus-linkos-shared-secret-0123456789";
const OTHER_SECRET = "proplus-linkos-shared-secret-9876543210";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function payload(overrides: Partial<SsoPayload> = {}): SsoPayload {
  return {
    iss: SSO_ISSUER,
    aud: SSO_AUDIENCE,
    sub: "lk-user-7f3a",
    email: "kim@example.com",
    name: "김영업",
    jti: "QkFTRTY0VVJMMTZCWVRF",
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 55,
    ...overrides,
  };
}

/** 와이어 형식의 독립 구현 — 위 파일 주석 참조. */
function signRaw(claims: unknown, secret: string): string {
  const bytes = Buffer.from(JSON.stringify(claims), "utf8");
  const sig = createHmac("sha256", secret).update(bytes).digest();
  return `v1.${bytes.toString("base64url")}.${sig.toString("base64url")}`;
}

function segments(token: string): [string, string, string] {
  const [v, p, s] = token.split(".");
  return [v ?? "", p ?? "", s ?? ""];
}

describe("05 §1: 와이어 형식 — 서명 입력은 디코딩된 payload 바이트다", () => {
  it("signAssertion 이 테스트의 독립 구현과 **같은 토큰**을 만든다", () => {
    const p = payload();
    expect(signAssertion(p, SECRET)).toBe(signRaw(p, SECRET));
  });

  it("토큰은 `v1.` 로 시작하고 세 조각이며 base64url 만 쓴다 (URL 에 그대로 들어간다)", () => {
    const token = signAssertion(payload(), SECRET);
    const [v, p, s] = segments(token);
    expect(v).toBe("v1");
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    // HMAC-SHA256 = 32바이트 = base64url 43자.
    expect(Buffer.from(s, "base64url")).toHaveLength(32);
  });

  it("payload 는 base64 **url** 이다 — `+` `/` `=` 가 들어가면 리다이렉트에서 깨진다", () => {
    // 평문에 `+`/`/` 를 만들어 내는 바이트를 일부러 넣는다.
    const token = signAssertion(payload({ name: "김영업 ~ ÿÿÿ", sub: "lk-ÿ?/+=" }), SECRET);
    expect(token).not.toMatch(/[+/=]/);
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(true);
  });

  it("32바이트보다 짧은 비밀값으로는 **발급 자체가 막힌다**", () => {
    expect(() => signAssertion(payload(), "too-short")).toThrow(/32/);
    expect(SSO_SECRET_MIN_BYTES).toBe(32);
  });
});

describe("05 §1: 통과 경로", () => {
  it("정상 토큰은 payload 를 그대로 돌려준다", () => {
    const p = payload();
    const r = verifyAssertion(signAssertion(p, SECRET), SECRET, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual(p);
  });

  it("`name` 이 없거나 null 이면 null 로 접는다 (표시 이름은 로그인 성립 조건이 아니다)", () => {
    const withNull = verifyAssertion(signAssertion(payload({ name: null }), SECRET), SECRET, NOW);
    expect(withNull.ok && withNull.payload.name).toBeNull();

    const { iss, aud, sub, email, jti, iat, exp } = payload();
    const withoutKey = verifyAssertion(signRaw({ iss, aud, sub, email, jti, iat, exp }, SECRET), SECRET, NOW);
    expect(withoutKey.ok && withoutKey.payload.name).toBeNull();
  });

  it("키 순서가 달라도 통과한다 (검증이 재직렬화를 거치지 않는 설계의 근거)", () => {
    const p = payload();
    const shuffled = { exp: p.exp, email: p.email, jti: p.jti, name: p.name, sub: p.sub, aud: p.aud, iat: p.iat, iss: p.iss };
    const r = verifyAssertion(signRaw(shuffled, SECRET), SECRET, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual(p);
  });

  it("시계 오차 30초 안의 미래 iat 는 통과한다", () => {
    const token = signAssertion(payload({ iat: NOW_SEC + SSO_CLOCK_SKEW_SEC }), SECRET);
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(true);
  });

  it("exp 가 1초 남았으면 통과한다 (경계)", () => {
    expect(verifyAssertion(signAssertion(payload({ exp: NOW_SEC + 1 }), SECRET), SECRET, NOW).ok).toBe(true);
  });

  it("**jti 는 형식만 본다** — 같은 토큰을 두 번 검증해도 둘 다 통과한다", () => {
    // 1회성은 `sso_assertions.jti` UNIQUE 가 보장한다(0003 마이그레이션). 순수 함수는
    // "이미 썼는지"를 알 수 없고, 알 수 있게 만들면 그건 I/O 다 — 이 테스트가 그 경계를 못 박는다.
    const token = signAssertion(payload(), SECRET);
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(true);
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(true);
  });
});

describe("05 §1 규칙 2: 서명 — 위조·변조·다른 키를 전부 거부한다", () => {
  it("서명을 한 글자 바꾸면 거부한다", () => {
    const [v, p, s] = segments(signAssertion(payload(), SECRET));
    const flipped = `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    const r = verifyAssertion(`${v}.${p}.${flipped}`, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("payload 를 바꾸고 원래 서명을 그대로 붙이면 거부한다 (권한 상승 경로)", () => {
    const [v, , s] = segments(signAssertion(payload(), SECRET));
    const tampered = Buffer.from(JSON.stringify(payload({ email: "admin@example.com" })), "utf8").toString("base64url");
    const r = verifyAssertion(`${v}.${tampered}.${s}`, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("다른 비밀값으로 서명된 토큰을 거부한다 (키 회전 중의 토큰도 여기로 떨어진다)", () => {
    const r = verifyAssertion(signAssertion(payload(), OTHER_SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("서명 길이가 달라도 **예외를 던지지 않고** 거부한다 (timingSafeEqual 의 함정)", () => {
    // timingSafeEqual 은 길이가 다르면 throw 한다. 길이로 조기 반환하면 그 분기가 길이를 흘린다.
    const [v, p] = segments(signAssertion(payload(), SECRET));
    for (const sig of ["A", "AAAA", "A".repeat(43), "A".repeat(200)]) {
      const r = verifyAssertion(`${v}.${p}.${sig}`, SECRET, NOW);
      expect(r.ok, `sig 길이 ${sig.length} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_signature");
    }
  });

  it("서명이 payload **문자열**이 아니라 바이트에 걸려 있다 — 같은 JSON 을 다시 인코딩해도 통과한다", () => {
    const p = payload();
    const bytes = Buffer.from(JSON.stringify(p), "utf8");
    const sig = createHmac("sha256", SECRET).update(bytes).digest();
    // base64url 패딩 없이 재인코딩한 같은 바이트 — 통과해야 한다.
    const token = `v1.${bytes.toString("base64url")}.${sig.toString("base64url")}`;
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(true);
  });

  it("비밀값이 없거나 32바이트보다 짧으면 설정 오류로 구분해 거부한다", () => {
    const token = signAssertion(payload(), SECRET);
    for (const bad of ["", "short", "a".repeat(SSO_SECRET_MIN_BYTES - 1)]) {
      const r = verifyAssertion(token, bad, NOW);
      expect(r.ok, `비밀값 길이 ${bad.length} 가 통과했다`).toBe(false);
      // "서명 불일치"로 숨기면 운영에서 설정 누락을 영원히 못 찾는다.
      if (!r.ok) expect(r.code).toBe("bad_secret");
    }
  });
});

describe("05 §1 규칙 3: iss / aud", () => {
  it("iss 가 linkos 가 아니면 거부한다 (서명이 유효해도)", () => {
    const r = verifyAssertion(signAssertion(payload({ iss: "proplus" }), SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_issuer");
  });

  it("aud 가 proplus 가 아니면 거부한다 — 다른 앱용 토큰의 재사용 차단", () => {
    for (const aud of ["linkos", "bu", "", "PROPLUS"]) {
      const r = verifyAssertion(signAssertion(payload({ aud }), SECRET), SECRET, NOW);
      expect(r.ok, `aud=${aud} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_audience");
    }
  });

  it("opts 로 기대값을 바꿀 수 있다 (스테이징에서만 쓴다)", () => {
    const token = signAssertion(payload({ iss: "linkos-staging", aud: "proplus-staging" }), SECRET);
    expect(verifyAssertion(token, SECRET, NOW).ok).toBe(false);
    expect(
      verifyAssertion(token, SECRET, NOW, { expectedIss: "linkos-staging", expectedAud: "proplus-staging" }).ok,
    ).toBe(true);
  });
});

describe("05 §1 규칙 4: 시간 — exp > now 그리고 iat <= now + 30s", () => {
  it("만료된 토큰을 거부한다", () => {
    const r = verifyAssertion(signAssertion(payload({ iat: NOW_SEC - 120, exp: NOW_SEC - 60 }), SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("expired");
  });

  it("exp === now 는 만료다 (경계는 닫혀 있다)", () => {
    const r = verifyAssertion(signAssertion(payload({ exp: NOW_SEC }), SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("expired");
  });

  it("시계 오차 허용을 넘는 미래 iat 를 거부한다", () => {
    const token = signAssertion(payload({ iat: NOW_SEC + SSO_CLOCK_SKEW_SEC + 1, exp: NOW_SEC + 600 }), SECRET);
    const r = verifyAssertion(token, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("iat_in_future");
  });

  it("now 가 Invalid Date 면 통과시키지 않는다 (fail-closed)", () => {
    const r = verifyAssertion(signAssertion(payload(), SECRET), SECRET, new Date("깨진 값"));
    expect(r.ok).toBe(false);
  });

  it("같은 토큰이 발급 전·유효·만료 후로 **시각에 따라** 판정된다", () => {
    const token = signAssertion(payload({ iat: NOW_SEC, exp: NOW_SEC + 60 }), SECRET);
    expect(verifyAssertion(token, SECRET, new Date((NOW_SEC - 60) * 1000)).ok).toBe(false);
    expect(verifyAssertion(token, SECRET, new Date((NOW_SEC + 30) * 1000)).ok).toBe(true);
    expect(verifyAssertion(token, SECRET, new Date((NOW_SEC + 61) * 1000)).ok).toBe(false);
  });
});

describe("05 §1 규칙 6: email — PROPLUS 는 이메일로 계정을 잇는다", () => {
  it("email 이 비어 있으면 거부한다", () => {
    for (const email of ["", "   ", "\t\n"]) {
      const r = verifyAssertion(signAssertion(payload({ email }), SECRET), SECRET, NOW);
      expect(r.ok, `email=${JSON.stringify(email)} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("email_missing");
    }
  });

  it("email 키가 아예 없으면 malformed 다 (타입이 틀린 payload 는 보정하지 않는다)", () => {
    const { iss, aud, sub, name, jti, iat, exp } = payload();
    const r = verifyAssertion(signRaw({ iss, aud, sub, name, jti, iat, exp }, SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("malformed");
  });

  it("254자를 넘는 주소는 거부한다 (RFC 5321 상한)", () => {
    const long = `${"a".repeat(250)}@example.com`;
    const r = verifyAssertion(signAssertion(payload({ email: long }), SECRET), SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("email_missing");
  });
});

describe("05 §1 규칙 1: 형식 — 깨진 입력은 서명 검사 전에 떨어진다", () => {
  it("세그먼트 개수가 3이 아니면 거부한다", () => {
    const [v, p, s] = segments(signAssertion(payload(), SECRET));
    for (const token of ["", "v1", `${v}.${p}`, `${v}.${p}.${s}.extra`, "...", `${p}.${s}`]) {
      const r = verifyAssertion(token, SECRET, NOW);
      expect(r.ok, `${JSON.stringify(token.slice(0, 20))} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("malformed");
    }
  });

  it("버전 접두사가 v1 이 아니면 거부한다 (형식 버전을 올릴 때의 안전장치)", () => {
    const [, p, s] = segments(signAssertion(payload(), SECRET));
    for (const v of ["v2", "V1", "", "v1 ", "jwt"]) {
      const r = verifyAssertion(`${v}.${p}.${s}`, SECRET, NOW);
      expect(r.ok, `버전 ${JSON.stringify(v)} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("malformed");
    }
  });

  it("base64url 밖의 문자를 거부한다 (표준 base64 의 + / = 포함)", () => {
    const [v, , s] = segments(signAssertion(payload(), SECRET));
    for (const p of ["a+b", "a/b", "abc=", "한글", "a b"]) {
      const r = verifyAssertion(`${v}.${p}.${s}`, SECRET, NOW);
      expect(r.ok, `payload ${JSON.stringify(p)} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("malformed");
    }
  });

  it("상한을 넘는 토큰은 HMAC·JSON.parse 전에 자른다", () => {
    const token = `v1.${"A".repeat(SSO_ASSERTION_MAX_LEN)}.AAAA`;
    const r = verifyAssertion(token, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("malformed");
  });

  it("서명은 맞지만 JSON 이 아니거나 객체가 아닌 payload 를 거부한다", () => {
    for (const body of ["not json", '["array"]', '"string"', "42", "null"]) {
      const bytes = Buffer.from(body, "utf8");
      const sig = createHmac("sha256", SECRET).update(bytes).digest();
      const r = verifyAssertion(`v1.${bytes.toString("base64url")}.${sig.toString("base64url")}`, SECRET, NOW);
      expect(r.ok, `payload ${body} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("malformed");
    }
  });

  it("클레임 타입이 틀리면 보정하지 않고 거부한다", () => {
    const bad: Record<string, unknown>[] = [
      { ...payload(), exp: "9999999999" }, // 문자열 exp — Number() 로 접으면 조용히 통과한다
      { ...payload(), iat: 1.5 },
      { ...payload(), exp: Number.MAX_SAFE_INTEGER + 2 },
      { ...payload(), sub: 123 },
      { ...payload(), sub: "" },
      { ...payload(), jti: "" },
      { ...payload(), jti: null },
      { ...payload(), name: 42 },
      { ...payload(), iss: null },
    ];
    for (const claims of bad) {
      const r = verifyAssertion(signRaw(claims, SECRET), SECRET, NOW);
      expect(r.ok, `${JSON.stringify(claims).slice(0, 60)} 가 통과했다`).toBe(false);
      if (!r.ok) expect(r.code).toBe("malformed");
    }
  });
});
