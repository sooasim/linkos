/**
 * P-041 텍스트 sanitizer · P-033 외부 링크 스킴 제한 (N-10)
 *
 * 수용 기준(01_FEATURE_REGISTRY.yaml):
 *   P-041 "script/style/on* 속성·javascript: 스킴 제거. 저장 시점과 렌더 시점 모두 적용"
 *   P-033 "http(s) 만 허용, javascript: 스킴 거부"
 * 비타협 원칙 N-10 "미니사이트에 사용자 JS 금지" (전략 §2 / 모듈명세 M03)
 *
 * 이 파일이 깨지면 공개 프로필에서 남의 스크립트가 돈다. 그래서 행복 경로는 거의 없고
 * **공격 벡터 전수**와 **경계**만 있다.
 */

import { describe, expect, it } from "vitest";
import { isSafeExternalUrl, sanitizeText, stripDangerousUrl } from "../src/sanitize";

/**
 * 보이지 않는 문자는 소스에 literal 로 박지 않고 코드포인트로 적는다.
 * 근거: sanitize.ts INVISIBLE_RANGES 주석 — 리뷰에서 무엇을 테스트하는지 읽을 수 없으면
 * 에디터·머지 도구가 조용히 바꿔도 알아챌 수 없다.
 */
const ZWSP = String.fromCodePoint(0x200b);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const LRM = String.fromCodePoint(0x200e);
const RLO = String.fromCodePoint(0x202e);
const WORD_JOINER = String.fromCodePoint(0x2060);
const BIDI_ISOLATE = String.fromCodePoint(0x2066);
const BOM = String.fromCodePoint(0xfeff);

/**
 * N-10 공격 벡터 전수. 각 항목은 "저장 전·렌더 전 어느 쪽을 통과해도 실행될 수 없어야 한다".
 * 새 우회가 보고되면 여기에 줄을 추가하는 것이 이 모듈의 유지보수 방식이다.
 */
const XSS_VECTORS: readonly string[] = [
  // 태그와 내용을 함께 버려야 하는 것들
  "<script>alert(1)</script>",
  "<ScRiPt>alert(1)</ScRiPt>", // 대소문자 섞기
  "<SCRIPT>alert(1)</script>", // 여는/닫는 태그 대소문자 불일치
  "<script >alert(1)</script >",
  "<script src=//evil.example/x.js></script>",
  "<script>alert(1)", // 닫히지 않은 태그
  "<style>body{background:url(javascript:alert(1))}</style>",
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "<object data=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\"></object>",
  "<embed src=//evil.example>",
  "<noscript><p>x</p></noscript>",
  "<template><script>alert(1)</script></template>",
  "<!--<script>alert(1)</script>-->", // 주석에 숨긴 스크립트
  // 이벤트 핸들러 속성
  "<img src=x onerror=alert(1)>",
  "<img src=x onerror=\"alert(1)\">",
  "<img src=x OnErRoR=alert(1)>",
  "<svg/onload=alert(1)>",
  "<body onload=alert(1)>",
  "<div onmouseover=alert(1)>hover</div>",
  // 위험 스킴을 담은 마크업
  "<a href=\"javascript:alert(1)\">link</a>",
  "<a href=\"JaVaScRiPt:alert(1)\">link</a>",
  "<a href=\"vbscript:msgbox(1)\">link</a>",
  "<a href=\"data:text/html,<script>alert(1)</script>\">link</a>",
  "<div style=\"background:expression(alert(1))\">x</div>",
  // 엔티티 인코딩
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;", // 이중 인코딩
  "&#60;script&#62;alert(1)&#60;/script&#62;", // 10진 수치 참조
  "&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;", // 16진 수치 참조
  "&#x3C;ScRiPt&#x3E;alert(1)&#x3C;/ScRiPt&#x3E;",
  // 널바이트·제어문자로 태그 이름 쪼개기
  "<scr\u0000ipt>alert(1)</scr\u0000ipt>",
  "<img src=x on\u0000error=alert(1)>",
  "<a href=\"java\u0009script:alert(1)\">x</a>",
  // 보이지 않는 문자로 태그 이름 섞기.
  // 소스에 literal 로 박지 않고 코드포인트로 적는다 — sanitize.ts INVISIBLE_RANGES 주석과 같은 이유.
  `<scr${ZWSP}ipt>alert(1)</scr${ZWSP}ipt>`,
  `<scr${LRM}ipt>alert(1)</scr${LRM}ipt>`,
  `<img src=x on${WORD_JOINER}error=alert(1)>`,
  "<form action=//evil.example><button>submit</button></form>",
];

/** 결과 문자열에 하나라도 남으면 안 되는 조각. 소문자로 비교한다. */
const MUST_NOT_SURVIVE: readonly string[] = [
  "<",
  ">",
  "script",
  "onerror",
  "onload",
  "onmouseover",
  "javascript:",
  "vbscript:",
  "expression(",
  "data:text/html",
];

describe("P-041 / N-10: 공격 벡터 전수 — 무해한 평문만 남는다 (모듈명세 M03)", () => {
  it("모든 벡터에서 태그·이벤트 핸들러·위험 스킴이 사라진다", () => {
    for (const vector of XSS_VECTORS) {
      const out = sanitizeText(vector).toLowerCase();
      for (const fragment of MUST_NOT_SURVIVE) {
        expect(out, `벡터 ${JSON.stringify(vector)} 에 '${fragment}' 가 남았다`).not.toContain(fragment);
      }
    }
  });

  it("내용까지 버려야 하는 요소는 본문도 평문으로 남지 않는다", () => {
    // 태그만 떼면 `alert(1)` 이 소개글 본문으로 남아 의미가 바뀐다.
    expect(sanitizeText("<script>alert(1)</script>")).toBe("");
    expect(sanitizeText("<style>.a{color:red}</style>")).toBe("");
    expect(sanitizeText("<iframe>프레임</iframe>")).toBe("");
    expect(sanitizeText("<noscript>대체문구</noscript>")).toBe("");
  });

  it("앞뒤 평문은 보존한다 (과잉 삭제로 소개글을 날리지 않는다)", () => {
    expect(sanitizeText("앞<script>alert(1)</script>뒤")).toBe("앞 뒤");
    expect(sanitizeText("<script>alert(1)</script>남은 문장")).toBe("남은 문장");
    expect(sanitizeText("<!-- 숨긴 메모 -->보이는 문장")).toBe("보이는 문장");
  });

  it("안전해 보이는 태그도 남기지 않는다 — 보존할 HTML 이 하나도 없다", () => {
    expect(sanitizeText("<b>굵게</b>")).toBe("굵게");
    expect(sanitizeText("<p>문단</p>")).toBe("문단");
    expect(sanitizeText("<br/>")).toBe("");
  });
});

describe("P-041: 엔티티 디코딩 경계", () => {
  function encodeOnce(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  it("디코딩 상한(3회)까지 겹쳐 인코딩한 스크립트를 모두 걷어낸다", () => {
    let layered = "<script>alert(1)</script>";
    for (let depth = 1; depth <= 3; depth++) {
      layered = encodeOnce(layered);
      expect(sanitizeText(layered), `${depth}중 인코딩`).toBe("");
    }
  });

  it("디코딩 상한을 넘겨도 꺾쇠가 복원되지 않아 태그가 될 수 없다", () => {
    // 상한 초과분은 `&lt;script&gt;` 형태의 **평문**으로 남는다. 어떤 렌더러에 넣어도
    // 꺾쇠가 없으므로 태그가 되지 않는다. (상한 초과 시 멱등성이 깨지는 점은 보고에 적었다.)
    let layered = "<script>alert(1)</script>";
    for (let depth = 1; depth <= 5; depth++) layered = encodeOnce(layered);
    const out = sanitizeText(layered);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("알 수 없는 엔티티는 원문을 유지한다 (저작권 기호 등을 뭉개지 않는다)", () => {
    expect(sanitizeText("&copy; 2026 PROPLUS")).toBe("&copy; 2026 PROPLUS");
    expect(sanitizeText("A &rarr; B")).toBe("A &rarr; B");
  });

  it("범위를 벗어난 수치 참조는 삭제한다", () => {
    expect(sanitizeText("a&#x110000;b")).toBe("ab"); // 0x10FFFF 초과
    expect(sanitizeText("a&#0;b")).toBe("ab"); // NUL 로 디코딩된 뒤 제어문자 제거
  });
});

describe("P-041: 널바이트·제어문자·보이지 않는 문자", () => {
  it("널바이트를 제거한다", () => {
    expect(sanitizeText("김\u0000도윤")).toBe("김도윤");
  });

  it("C0·C1 제어문자를 제거한다", () => {
    expect(sanitizeText("a\u0001\u0008\u000B\u000C\u001Fb")).toBe("ab");
    expect(sanitizeText("a\u007F\u0085\u009Fb")).toBe("ab");
  });

  it("탭·개행은 제어문자가 아니라 공백으로 다룬다", () => {
    expect(sanitizeText("a\tb")).toBe("a b");
    expect(sanitizeText("a\r\nb")).toBe("a\nb");
  });

  it("zero-width·bidi·BOM 을 제거한다 (같은 글자로 보이는 다른 문자열 금지)", () => {
    for (const invisible of [ZWSP, ZWNJ, LRM, RLO, WORD_JOINER, BIDI_ISOLATE, BOM]) {
      const cp = invisible.codePointAt(0)?.toString(16) ?? "?";
      expect(sanitizeText(`관${invisible}리`), `U+${cp} 이 남았다`).toBe("관리");
    }
  });

  it("ZWJ 와 정상 서로게이트 쌍은 남긴다 (이모지가 깨지면 안 된다)", () => {
    expect(sanitizeText(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
    expect(sanitizeText("👍 좋아요")).toBe("👍 좋아요");
  });

  it("짝 없는 서로게이트는 제거한다", () => {
    expect(sanitizeText("a\uD800b")).toBe("ab");
    expect(sanitizeText("a\uDFFFb")).toBe("ab");
  });
});

describe("P-041: 공백 정규화와 길이 경계", () => {
  it("단락 구분(빈 줄 하나)은 남기고 그 이상은 접는다", () => {
    expect(sanitizeText("줄1\n줄2")).toBe("줄1\n줄2");
    expect(sanitizeText("줄1\n\n줄2")).toBe("줄1\n\n줄2");
    expect(sanitizeText("줄1\n\n\n\n\n줄2")).toBe("줄1\n\n줄2");
    expect(sanitizeText("  줄1  \n  줄2  ")).toBe("줄1\n줄2");
  });

  it("maxLen 을 코드포인트 기준으로 자른다 (서로게이트 쌍이 쪼개지지 않는다)", () => {
    expect(sanitizeText("가".repeat(50), 10)).toBe("가".repeat(10));
    const emoji = sanitizeText("👍".repeat(10), 5);
    expect(Array.from(emoji)).toHaveLength(5);
    expect(emoji).toBe("👍".repeat(5));
  });

  it("경계: maxLen 과 같은 길이는 그대로, 한 글자 넘으면 잘린다", () => {
    expect(sanitizeText("a".repeat(10), 10)).toBe("a".repeat(10));
    expect(sanitizeText("a".repeat(11), 10)).toBe("a".repeat(10));
  });

  it("자르고 난 끝의 공백은 남기지 않는다", () => {
    expect(sanitizeText("aaaaaaaaaa b", 11)).toBe("a".repeat(10));
  });

  it("maxLen 이 유효하지 않으면 기본 상한(2000)을 쓴다", () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sanitizeText("a".repeat(2500), bad), `maxLen=${bad}`).toHaveLength(2000);
    }
  });

  it("문자열이 아닌 입력은 빈 문자열이다 (JSON 본문에서 숫자·객체가 들어올 수 있다)", () => {
    expect(sanitizeText(null as unknown as string)).toBe("");
    expect(sanitizeText(undefined as unknown as string)).toBe("");
    expect(sanitizeText(42 as unknown as string)).toBe("");
    expect(sanitizeText({} as unknown as string)).toBe("");
  });
});

describe("P-041: 멱등성 — 저장 전과 렌더 전 두 번 통과해도 같은 값이어야 한다", () => {
  const CORPUS: readonly string[] = [
    ...XSS_VECTORS,
    "",
    "   ",
    "김도윤 · 의료기기 유통 15년",
    "줄1\n\n줄2\n\n\n줄3",
    "a < b 이고 b > c",
    "&copy; 2026",
    `👍 좋아요 ${ZWSP}${BOM} 숨은 문자`,
    "a\u0000b\u0001c",
    "a".repeat(2500),
  ];

  it("sanitizeText(sanitizeText(x)) === sanitizeText(x)", () => {
    for (const x of CORPUS) {
      const once = sanitizeText(x);
      expect(sanitizeText(once), `입력 ${JSON.stringify(x.slice(0, 60))}`).toBe(once);
    }
  });

  it("maxLen 을 줘도 멱등이다", () => {
    for (const x of CORPUS) {
      const once = sanitizeText(x, 40);
      expect(sanitizeText(once, 40), `입력 ${JSON.stringify(x.slice(0, 60))}`).toBe(once);
    }
  });
});

describe("P-033: stripDangerousUrl 은 http/https 만 통과시킨다", () => {
  const BAD_URLS: readonly string[] = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)", // 탭으로 스킴 숨기기
    "java\nscript:alert(1)",
    "java\u0000script:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "tel:+8201012345678",
    "sms:+8201012345678",
    "ftp://example.com/x",
    "about:blank",
    "blob:https://example.com/abc",
    "chrome://settings",
    "ws://example.com/socket",
    "intent://evil#Intent;scheme=http;end",
    // 스킴이 없는 입력은 외부 링크가 아니다
    "/p/kim",
    "./relative",
    "example.com",
    "//example.com",
    "",
    "   ",
  ];

  it("허용 밖 스킴·상대경로를 전부 null 로 거부한다", () => {
    for (const url of BAD_URLS) {
      expect(stripDangerousUrl(url), `URL ${JSON.stringify(url)} 가 통과했다`).toBeNull();
    }
  });

  it("자격증명을 담은 URL 은 거부한다 (호스트 사칭)", () => {
    expect(stripDangerousUrl("https://proplus.linkos.com@evil.example/")).toBeNull();
    expect(stripDangerousUrl("https://user:pass@example.com/")).toBeNull();
  });

  it("http/https 는 통과하고 정규화된 값을 돌려준다", () => {
    expect(stripDangerousUrl("https://example.com")).toBe("https://example.com/");
    expect(stripDangerousUrl("http://example.com/a/b?c=d#e")).toBe("http://example.com/a/b?c=d#e");
    expect(stripDangerousUrl("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
    expect(stripDangerousUrl("https://example.com:8443/x")).toBe("https://example.com:8443/x");
  });

  it("경계: 2048자는 통과하고 2049자는 거부한다", () => {
    const base = "https://example.com/";
    expect(base).toHaveLength(20);
    expect(stripDangerousUrl(base + "a".repeat(2048 - base.length))).not.toBeNull();
    expect(stripDangerousUrl(base + "a".repeat(2049 - base.length))).toBeNull();
  });

  it("문자열이 아닌 입력은 null 이다", () => {
    expect(stripDangerousUrl(null as unknown as string)).toBeNull();
    expect(stripDangerousUrl(undefined as unknown as string)).toBeNull();
    expect(stripDangerousUrl(123 as unknown as string)).toBeNull();
  });

  it("isSafeExternalUrl 은 stripDangerousUrl 과 같은 판정이다 (렌더 가드가 어긋나면 안 된다)", () => {
    const all = [...BAD_URLS, "https://example.com", "http://example.com/a", "https://한글.example/소개"];
    for (const url of all) {
      expect(isSafeExternalUrl(url), `URL ${JSON.stringify(url)}`).toBe(stripDangerousUrl(url) !== null);
    }
  });
});
