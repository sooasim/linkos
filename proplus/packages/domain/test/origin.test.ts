/**
 * P-188 CSRF·origin 검사 — 수용 기준: "변경 요청은 **허용된 origin 에서만**".
 * 계약(CONTRACTS.md §origin.ts): "origin 없음 → true(비브라우저). origin 이 appOrigin 또는 host 와 같으면 true."
 *
 * 이 검사가 무너지는 전형적인 방식은 "비슷한 도메인"이다 —
 * 그래서 아래는 통과 경로보다 **거부 경로**(사칭·포트·스킴·null origin)에 무게를 둔다.
 */

import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../src/origin";

/** 운영 주소 (전략 §10). */
const APP = "https://proplus.linkos.com";
const APP_HOST = "proplus.linkos.com";

describe("P-188: Origin 이 없는 요청은 CSRF 가 성립하지 않으므로 통과시킨다", () => {
  it("null·빈 문자열·공백만 있는 헤더는 통과한다 (서버 간 호출·curl·모바일)", () => {
    for (const origin of [null, "", "   "]) {
      expect(isAllowedOrigin(origin, APP_HOST, APP), `${JSON.stringify(origin)}`).toBe(true);
    }
  });

  it("host 와 appOrigin 이 둘 다 없어도 origin 이 없으면 통과한다", () => {
    expect(isAllowedOrigin(null, null)).toBe(true);
  });
});

describe("P-188: 허용 경로 — appOrigin 또는 Host 와 같은 origin", () => {
  it("appOrigin 과 같으면 통과한다", () => {
    expect(isAllowedOrigin(APP, null, APP)).toBe(true);
  });

  it("Host 헤더와 같으면 통과한다 (임시 도메인 proplus.ckp.kr — 전략 §10)", () => {
    expect(isAllowedOrigin("https://proplus.ckp.kr", "proplus.ckp.kr")).toBe(true);
    expect(isAllowedOrigin("http://localhost:4400", "localhost:4400")).toBe(true);
  });

  it("호스트 대소문자는 같은 호스트로 본다 (DNS 는 대소문자를 구분하지 않는다)", () => {
    expect(isAllowedOrigin("https://PROPLUS.LINKOS.COM", null, APP)).toBe(true);
    expect(isAllowedOrigin(APP, "PROPLUS.LINKOS.COM")).toBe(true);
  });

  it("Origin 에 경로가 붙어 와도 호스트로 판정한다", () => {
    expect(isAllowedOrigin("https://proplus.linkos.com/p/kim", null, APP)).toBe(true);
  });

  it("기본 포트(443)를 명시해도 같은 사이트다", () => {
    expect(isAllowedOrigin("https://proplus.linkos.com:443", null, APP)).toBe(true);
  });

  it("appOrigin 이 없으면 Host 만으로 판정한다 (설정 누락이 전면 차단이 되지는 않는다)", () => {
    expect(isAllowedOrigin(APP, APP_HOST)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", APP_HOST)).toBe(false);
  });
});

describe("P-188: 거부 경로 — 다른 사이트는 전부 막는다", () => {
  it("완전히 다른 도메인은 거부한다", () => {
    expect(isAllowedOrigin("https://evil.com", APP_HOST, APP)).toBe(false);
    expect(isAllowedOrigin("https://linkos.ckp.kr", APP_HOST, APP)).toBe(false); // LINKOS 도 다른 사이트다
  });

  it("비슷한 이름으로 사칭하는 호스트를 전수로 거부한다", () => {
    const spoofs = [
      "https://evil-proplus.linkos.com", // 접두사 붙이기
      "https://proplus.linkos.com.evil.com", // 접미사 붙이기
      "https://proplus.linkos.co", // TLD 한 글자 깎기
      "https://proplus-linkos.com", // 점을 하이픈으로
      "https://sub.proplus.linkos.com", // 하위 도메인
      "https://proplus.linkos.com@evil.com", // userinfo 로 눈속임 (실제 호스트는 evil.com)
      "https://xn--proplus.linkos.com", // punycode 흉내
    ];
    for (const origin of spoofs) {
      expect(isAllowedOrigin(origin, APP_HOST, APP), `${origin} 가 통과했다`).toBe(false);
    }
  });

  it("포트가 다르면 다른 origin 이다", () => {
    expect(isAllowedOrigin("https://proplus.linkos.com:8443", null, APP)).toBe(false);
    expect(isAllowedOrigin("http://localhost:4401", "localhost:4400")).toBe(false);
    expect(isAllowedOrigin("https://proplus.linkos.com:4400", APP_HOST, APP)).toBe(false);
  });

  it("'null' 문자열 origin 은 거부한다 (sandbox iframe·data: 문서)", () => {
    expect(isAllowedOrigin("null", APP_HOST, APP)).toBe(false);
    expect(isAllowedOrigin("null", null, APP)).toBe(false);
  });

  it("http(s) 가 아닌 스킴은 거부한다", () => {
    for (const origin of ["file:///tmp/x.html", "data:text/html,<form>", "javascript:alert(1)", "chrome-extension://abcdefgh"]) {
      expect(isAllowedOrigin(origin, APP_HOST, APP), `${origin} 가 통과했다`).toBe(false);
    }
  });

  it("URL 로 파싱되지 않는 값은 거부한다 (헤더 위조·깨진 프록시)", () => {
    for (const origin of ["not a url", "proplus.linkos.com", "//proplus.linkos.com", "https://"]) {
      expect(isAllowedOrigin(origin, APP_HOST, APP), `${origin} 가 통과했다`).toBe(false);
    }
  });

  it("appOrigin 설정값이 깨져 있어도 origin 이 통과하지 않는다", () => {
    expect(isAllowedOrigin(APP, null, "설정안됨")).toBe(false);
    expect(isAllowedOrigin(APP, null, "")).toBe(false);
  });

  it("Host 가 비어 있으면 appOrigin 만으로 판정한다", () => {
    expect(isAllowedOrigin(APP, "", APP)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", "   ", APP)).toBe(false);
  });
});

describe("P-188: appOrigin 이 설정되면 스킴까지 비교한다", () => {
  // 호스트만 비교하면 `http://proplus.linkos.com` 이 `https://...` 설정을 통과한다.
  // 평문 HTTP 페이지는 중간자가 내용을 주입할 수 있으므로, "Origin 은 스크립트가 위조할 수
  // 없다"는 이 검사의 전제가 그 경로에서 무너진다.
  it("스킴이 다른 origin 은 거부한다", () => {
    expect(isAllowedOrigin("http://proplus.linkos.com", null, APP)).toBe(false);
  });

  it("스킴까지 같으면 통과한다", () => {
    expect(isAllowedOrigin("https://proplus.linkos.com", null, APP)).toBe(true);
  });

  it("appOrigin 이 설정되면 Host 헤더 폴백으로 우회되지 않는다", () => {
    // Host 에는 스킴이 없으므로, appOrigin 이 있을 때 Host 폴백을 허용하면
    // 위 거부가 그대로 되살아난다. appOrigin 이 설정된 환경에서는 그것이 유일한 기준이다.
    expect(isAllowedOrigin("http://proplus.linkos.com", "proplus.linkos.com", APP)).toBe(false);
  });

  it("appOrigin 이 없으면 Host 헤더로 판정한다 (로컬 개발·프리뷰)", () => {
    expect(isAllowedOrigin("http://localhost:4400", "localhost:4400")).toBe(true);
    expect(isAllowedOrigin("http://evil.com", "localhost:4400")).toBe(false);
  });
});
