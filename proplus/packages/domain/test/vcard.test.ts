/**
 * P-035 QR·vCard·공유 링크
 *
 * 수용 기준(01_FEATURE_REGISTRY.yaml P-035):
 *   "vCard 는 공개 허용 필드만 포함하고 비공개 연락처를 넣지 않는다"
 *
 * vCard 는 **우리 손을 떠나는 산출물**이다. 한 번 흘린 연락처는 비공개로 되돌릴 수 없고,
 * 값에 CRLF 가 남으면 다른 사람의 TEL 을 끼워 넣는 주입이 된다. 그래서 이 파일은
 * (a) 없는 값은 줄이 아예 없는지 (b) 이스케이프가 주입을 막는지 (c) 줄 구분이 CRLF 인지를 본다.
 */

import { describe, expect, it } from "vitest";
import { buildVCard } from "../src/vcard";

/** 역슬래시를 소스에 literal 로 쓰면 TS 이스케이프와 vCard 이스케이프가 섞여 읽을 수 없다. */
const BS = String.fromCharCode(0x5c);
const URL_OK = "https://proplus.linkos.com/p/kim";

/** CRLF 로 쪼갠 줄 목록. 마지막 CRLF 가 없으면 여기서 먼저 실패한다. */
function lines(out: string): string[] {
  expect(out.endsWith("\r\n"), "vCard 는 CRLF 로 끝나야 한다").toBe(true);
  return out.slice(0, -2).split("\r\n");
}

describe("P-035: 줄 구분은 CRLF 다 (RFC 2426 — LF 만 쓰면 iOS 연락처가 거부한다)", () => {
  it("모든 줄 구분이 CRLF 이고 홀로 남은 LF·CR 이 없다", () => {
    const out = buildVCard({
      displayName: "김도윤",
      headline: "의료기기 유통",
      org: "주식회사 예시",
      url: URL_OK,
      email: "kim@example.com",
      phone: "010-0000-0000",
    });
    const withoutCrlf = out.replace(/\r\n/g, "");
    expect(withoutCrlf).not.toContain("\n");
    expect(withoutCrlf).not.toContain("\r");
  });

  it("BEGIN·VERSION 으로 시작하고 END 로 끝난다", () => {
    const l = lines(buildVCard({ displayName: "김도윤", url: URL_OK }));
    expect(l[0]).toBe("BEGIN:VCARD");
    expect(l[1]).toBe("VERSION:3.0");
    expect(l.at(-1)).toBe("END:VCARD");
  });

  it("모든 필드가 있으면 정해진 순서로 나온다", () => {
    const l = lines(
      buildVCard({
        displayName: "김도윤",
        headline: "의료기기 유통 15년",
        org: "주식회사 예시",
        url: URL_OK,
        email: "kim@example.com",
        phone: "010-0000-0000",
      }),
    );
    expect(l).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:김도윤",
      "N:김도윤;;;;",
      "TITLE:의료기기 유통 15년",
      "ORG:주식회사 예시",
      `URL:${URL_OK}`,
      "EMAIL;TYPE=INTERNET:kim@example.com",
      "TEL;TYPE=CELL:010-0000-0000",
      "END:VCARD",
    ]);
  });
});

describe("P-035: 연락처가 없으면 TEL·EMAIL 줄이 아예 없다", () => {
  it("이메일·전화를 넘기지 않으면 그 줄이 생기지 않는다", () => {
    const l = lines(buildVCard({ displayName: "김도윤", url: URL_OK }));
    expect(l).toEqual(["BEGIN:VCARD", "VERSION:3.0", "FN:김도윤", "N:김도윤;;;;", `URL:${URL_OK}`, "END:VCARD"]);
    expect(l.some((x) => x.startsWith("TEL"))).toBe(false);
    expect(l.some((x) => x.startsWith("EMAIL"))).toBe(false);
  });

  it("빈 값·공백·null·undefined·제어문자만 있는 값은 줄을 만들지 않는다", () => {
    // 전수. 빈 TEL/EMAIL 은 주소록 앱에서 깨진 연락처로 보이고, 더 중요하게는
    // "연락처가 있는 것처럼" 보이게 만든다.
    const emptyish: readonly (string | null | undefined)[] = [null, undefined, "", "   ", "\t", "\u0000", "\u007F"];
    for (const value of emptyish) {
      const l = lines(
        buildVCard({ displayName: "김도윤", url: URL_OK, headline: value, org: value, email: value, phone: value }),
      );
      expect(l, `값 ${JSON.stringify(value)}`).toEqual([
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:김도윤",
        "N:김도윤;;;;",
        `URL:${URL_OK}`,
        "END:VCARD",
      ]);
    }
  });

  it("한쪽만 있으면 그 줄만 생긴다", () => {
    const onlyEmail = lines(buildVCard({ displayName: "김도윤", url: URL_OK, email: "kim@example.com" }));
    expect(onlyEmail.some((x) => x.startsWith("EMAIL"))).toBe(true);
    expect(onlyEmail.some((x) => x.startsWith("TEL"))).toBe(false);

    const onlyPhone = lines(buildVCard({ displayName: "김도윤", url: URL_OK, phone: "010-0000-0000" }));
    expect(onlyPhone.some((x) => x.startsWith("TEL"))).toBe(true);
    expect(onlyPhone.some((x) => x.startsWith("EMAIL"))).toBe(false);
  });
});

describe("P-035: 특수문자 이스케이프 (RFC 2426 §2.4.2)", () => {
  it("세미콜론·쉼표·역슬래시를 이스케이프한다", () => {
    const out = buildVCard({ displayName: `Kim; Jane, PhD ${BS} X`, url: URL_OK });
    // 역슬래시를 **먼저** 바꿔야 뒤에서 만든 `\;` `\,` 가 다시 escape 되지 않는다.
    expect(out).toContain(`FN:Kim${BS}; Jane${BS}, PhD ${BS}${BS} X`);
  });

  it("줄바꿈은 리터럴 `\\n` 으로 접는다 — 값에 CRLF 가 남으면 줄 주입이 된다", () => {
    const out = buildVCard({ displayName: `A${BS}nB`, url: URL_OK, org: "1행\r\n2행", email: "a\nb@example.com" });
    const l = lines(out);
    // org 가 두 줄로 쪼개지지 않았다 = 주입 불가
    expect(l.filter((x) => x.startsWith("ORG:"))).toHaveLength(1);
    expect(l).toContain(`ORG:1행${BS}n2행`);
    // 이미 역슬래시+n 인 입력은 역슬래시가 escape 되어 `\\n` 이 된다 (의미가 바뀌지 않는다)
    expect(l).toContain(`FN:A${BS}${BS}nB`);
  });

  it("이름에 END:VCARD·TEL 줄을 심어도 새 줄이 생기지 않는다 (주입 방어)", () => {
    const l = lines(
      buildVCard({ displayName: "홍길동\r\nTEL;TYPE=CELL:01000000000\r\nEND:VCARD", url: URL_OK }),
    );
    expect(l).toHaveLength(6); // BEGIN VERSION FN N URL END
    expect(l.some((x) => x.startsWith("TEL"))).toBe(false);
    expect(l.filter((x) => x === "END:VCARD")).toHaveLength(1);
  });

  it("URL 안의 쉼표·세미콜론도 이스케이프한다 (파서가 파라미터로 오해한다)", () => {
    const l = lines(buildVCard({ displayName: "김도윤", url: "https://example.com/a,b;c" }));
    expect(l).toContain(`URL:https://example.com/a${BS},b${BS};c`);
  });

  it("N 속성도 같은 이스케이프를 쓴다", () => {
    const l = lines(buildVCard({ displayName: "Kim; Jane", url: URL_OK }));
    expect(l).toContain(`N:Kim${BS}; Jane;;;;`);
  });

  it("값의 앞뒤 공백은 떼어낸다", () => {
    const l = lines(buildVCard({ displayName: "  김도윤  ", url: URL_OK, org: "  예시  " }));
    expect(l).toContain("FN:김도윤");
    expect(l).toContain("ORG:예시");
  });
});

describe("P-035: displayName 은 필수다 (FN 없는 vCard 는 누구의 것인지 알 수 없다)", () => {
  it("빈 값·공백·제어문자만 있는 이름은 예외를 던진다", () => {
    for (const bad of ["", "   ", "\t", "\u0000", "\u0000\u0001", "\u007F"]) {
      expect(() => buildVCard({ displayName: bad, url: URL_OK }), `이름 ${JSON.stringify(bad)}`).toThrow(
        /vcard:display_name_required/,
      );
    }
  });

  it("이름이 있으면 던지지 않는다", () => {
    expect(() => buildVCard({ displayName: "김", url: URL_OK })).not.toThrow();
  });
});

describe("P-035: URL 은 스킴을 한 번 더 확인한다 (P-033)", () => {
  it("http(s) 가 아니면 URL 줄 없이 vCard 를 만든다", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd", "/p/kim", ""]) {
      const l = lines(buildVCard({ displayName: "김도윤", url: bad }));
      expect(l.some((x) => x.startsWith("URL:")), `URL ${JSON.stringify(bad)} 가 들어갔다`).toBe(false);
      // 그래도 유효한 vCard 여야 한다 — 링크 하나 때문에 공유가 실패하면 안 된다.
      expect(l[0]).toBe("BEGIN:VCARD");
      expect(l.at(-1)).toBe("END:VCARD");
    }
  });

  it("URL 은 정규화된 값으로 들어간다", () => {
    expect(lines(buildVCard({ displayName: "김도윤", url: "HTTPS://PROPLUS.LINKOS.COM/p/Kim" }))).toContain(
      "URL:https://proplus.linkos.com/p/Kim",
    );
    expect(lines(buildVCard({ displayName: "김도윤", url: "https://example.com" }))).toContain(
      "URL:https://example.com/",
    );
  });
});

describe("P-035: 받은 것만 쓴다 (N-4 — 프로필에서 값을 더 끌어오지 않는다)", () => {
  it("입력에 없는 속성은 출력에 없다", () => {
    const l = lines(buildVCard({ displayName: "김도윤", url: URL_OK }));
    for (const absent of ["TITLE", "ORG", "EMAIL", "TEL", "ADR", "NOTE", "PHOTO", "BDAY", "CATEGORIES", "X-"]) {
      expect(l.some((x) => x.startsWith(absent)), `${absent} 가 생성됐다`).toBe(false);
    }
  });

  it("긴 줄을 접지 않는다 (멀티바이트 한글이 쪼개지는 쪽이 더 큰 위험이다)", () => {
    const longName = "김".repeat(120);
    const l = lines(buildVCard({ displayName: longName, url: URL_OK }));
    const fn = l.find((x) => x.startsWith("FN:"));
    expect(fn).toBe(`FN:${longName}`);
    expect(fn?.length).toBeGreaterThan(75); // RFC 의 75옥텟 folding 을 적용하지 않는다
  });
});
