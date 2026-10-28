/**
 * P-020 프로필 생성과 slug 예약
 *
 * 수용 기준(01_FEATURE_REGISTRY.yaml P-020):
 *   "slug 는 예약어·중복·대소문자 혼동을 거부하고 소유자만 변경 가능"
 *   중복은 DB UNIQUE, 소유자 판정은 acl.ts 이므로 이 파일은 **문자열 적격성**만 본다.
 *
 * 왜 이 테스트가 중요한가: `/p/{slug}` 는 공개 주소다. 두 입력이 같은 주소로 접히거나
 * 플랫폼 경로를 사칭하면 "이 프로필의 검증 표시는 이 사람의 것"이라는 PROPLUS 의 전제가 깨진다.
 */

import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, normalizeSlug, validateSlug } from "../src/slug";

/** 구현과 같은 값을 쓰되 **문서가 요구하는 경계**로서 테스트가 직접 들고 있는다. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 40;

/** 거부 코드만 꺼낸다. 통과했으면 null — 실패 메시지가 "null 이 아니다"로 읽히게 한다. */
function code(raw: string): string | null {
  const r = validateSlug(raw);
  return r.ok ? null : r.code;
}

function accepted(raw: string): string | null {
  const r = validateSlug(raw);
  return r.ok ? r.slug : null;
}

describe("P-020: 예약어는 어떤 표기로 들어와도 거부된다", () => {
  it("RESERVED_SLUGS 전체가 거부된다", () => {
    // 전수. 목록에 항목을 추가했는데 길이·정규화 때문에 실제로는 통과하는 항목이 생기면 여기서 잡힌다.
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved).ok, `예약어 '${reserved}' 가 통과했다`).toBe(false);
    }
  });

  it("길이 하한을 넘는 예약어는 slug_reserved 로 거부된다", () => {
    // `p`·`me` 는 정규화 후 3자 미만이라 길이 검사가 먼저 걸린다(거부는 되지만 코드가 다르다).
    for (const reserved of RESERVED_SLUGS) {
      if (normalizeSlug(reserved).length < MIN_LENGTH) continue;
      expect(code(reserved), `예약어 '${reserved}'`).toBe("slug_reserved");
    }
  });

  it("대문자·공백·밑줄로 위장한 예약어도 거부된다 (대소문자 혼동 거부)", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved.toUpperCase()).ok, `'${reserved}' 대문자`).toBe(false);
      expect(validateSlug(`  ${reserved}  `).ok, `'${reserved}' 공백 포함`).toBe(false);
      expect(validateSlug(`-${reserved}-`).ok, `'${reserved}' 양끝 하이픈`).toBe(false);
    }
  });

  it("전각 문자로 위장한 예약어도 NFKC 로 접혀 거부된다", () => {
    expect(code("ＡＰＩ")).toBe("slug_reserved"); // ＡＰＩ → api
    expect(code("ａｄｍｉｎ")).toBe("slug_reserved"); // ａｄｍｉｎ → admin
  });

  it("Next.js 내부 경로 `_next` 는 접힌 모양(`next`)으로도 예약돼 있다", () => {
    expect(code("_next")).toBe("slug_reserved");
    expect(code("next")).toBe("slug_reserved");
    expect(code("__next__")).toBe("slug_reserved");
  });

  it("예약어를 포함하지만 다른 주소는 허용된다 (과잉 차단 금지)", () => {
    expect(accepted("admin-kim")).toBe("admin-kim");
    expect(accepted("api-consulting")).toBe("api-consulting");
    expect(accepted("helper")).toBe("helper");
  });
});

describe("P-020: 길이 경계", () => {
  it(`${MIN_LENGTH - 1}자는 거부하고 ${MIN_LENGTH}자는 허용한다`, () => {
    expect(code("ab")).toBe("slug_too_short");
    expect(accepted("abc")).toBe("abc");
  });

  it(`${MAX_LENGTH}자는 허용하고 ${MAX_LENGTH + 1}자는 거부한다`, () => {
    const max = "a".repeat(MAX_LENGTH);
    expect(accepted(max)).toBe(max);
    expect(code("a".repeat(MAX_LENGTH + 1))).toBe("slug_too_long");
  });

  it("길이는 정규화 **후** 기준이다", () => {
    // 공백·대문자를 섞어 길이를 늘려도 접힌 결과가 상한 안이면 통과해야 한다.
    expect(accepted("  A B  ")).toBe("a-b");
    // 삭제되는 문자는 길이에 세지 않는다 — 점 세 개는 사라지므로 40자는 그대로 통과한다.
    expect(accepted(`${"a".repeat(MAX_LENGTH)}...`)).toBe("a".repeat(MAX_LENGTH));
    // 허용 문자만 세어 상한을 넘으면 거부된다.
    expect(code(`${"a".repeat(MAX_LENGTH + 1)}...`)).toBe("slug_too_long");
  });
});

describe("P-020: 내부 식별자·사칭 모양 거부", () => {
  it("숫자만인 주소는 거부한다 (`/p/123` 을 ID 경로로 열 여지를 남긴다)", () => {
    expect(code("123")).toBe("slug_numeric_only");
    expect(code("00000000")).toBe("slug_numeric_only");
    expect(code("１２３")).toBe("slug_numeric_only"); // 전각 １２３
  });

  it("숫자에 문자·하이픈이 하나라도 섞이면 허용한다", () => {
    expect(accepted("1-2")).toBe("1-2");
    expect(accepted("a12")).toBe("a12");
    expect(accepted("12a")).toBe("12a");
  });

  it("'xn--' punycode 접두사는 거부한다 (호모그래프 사칭)", () => {
    expect(code("xn--abc123")).toBe("slug_punycode");
    expect(code("XN--ABC123")).toBe("slug_punycode");
    expect(code("  xn--bcher-kva  ")).toBe("slug_punycode");
    expect(code("ｘｎ--abc1")).toBe("slug_punycode"); // 전각 ｘｎ--
  });

  it("'xn' 로만 시작하는 정상 주소는 허용한다", () => {
    expect(accepted("xn-abc")).toBe("xn-abc");
    expect(accepted("xnavier")).toBe("xnavier");
  });
});

describe("P-020: 정규화 (두 입력이 같은 주소로 접히면 같은 결과를 내야 한다)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["JaneDoe", "janedoe"],
    ["Jane Doe", "jane-doe"],
    ["jane_doe", "jane-doe"],
    ["jane\tdoe", "jane-doe"],
    ["jane\ndoe", "jane-doe"],
    ["jane---doe", "jane-doe"],
    ["-jane-doe-", "jane-doe"],
    ["___jane___doe___", "jane-doe"],
    ["  Jane__Doe--Pro  ", "jane-doe-pro"],
    ["jane.doe", "janedoe"], // 허용 밖 문자는 삭제한다 — 하이픈으로 바꾸지 않는다
    ["jane@doe!", "janedoe"],
    ["박사jane", "jane"], // 한글은 삭제
  ];

  it("정규화 결과가 한 가지 모양으로 접힌다", () => {
    for (const [raw, want] of cases) {
      expect(normalizeSlug(raw), `입력 ${JSON.stringify(raw)}`).toBe(want);
    }
  });

  it("성공 시 반환값은 **정규화된 slug** 다 (호출부는 입력 원문을 저장해선 안 된다)", () => {
    for (const [raw, want] of cases) {
      expect(accepted(raw), `입력 ${JSON.stringify(raw)}`).toBe(want);
    }
  });

  it("정규화는 멱등이다 (저장된 slug 를 다시 접어도 그대로다)", () => {
    for (const [raw] of cases) {
      const once = normalizeSlug(raw);
      expect(normalizeSlug(once), `입력 ${JSON.stringify(raw)}`).toBe(once);
    }
  });
});

describe("P-020: 남는 문자가 없는 입력", () => {
  it("전부 하이픈인 입력은 slug_empty 다", () => {
    expect(code("-")).toBe("slug_empty");
    expect(code("---")).toBe("slug_empty");
    expect(code("-----------")).toBe("slug_empty");
  });

  it("구분자만 있는 입력도 slug_empty 다", () => {
    expect(code("___")).toBe("slug_empty");
    expect(code("   ")).toBe("slug_empty");
    expect(code("")).toBe("slug_empty");
  });

  it("허용 문자가 하나도 없는 입력은 slug_empty 다", () => {
    expect(code("박사님")).toBe("slug_empty"); // 한글만
    expect(code("!@#$%^&*()")).toBe("slug_empty");
    expect(code("👍")).toBe("slug_empty"); // 이모지만
  });
});
