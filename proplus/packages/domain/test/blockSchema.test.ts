/**
 * P-040 블록 schema allowlist (N-10 — 미니사이트에 사용자 JS 금지)
 *
 * 수용 기준(01_FEATURE_REGISTRY.yaml P-040):
 *   "허용된 블록 타입·속성만 저장된다. 임의 HTML 문자열 저장 경로가 없다"
 * 근거: 전략 §2 N-10 / 모듈명세 M03 / N-8(지표는 기간·분모 없이 표시 불가)
 *
 * 이 파일이 지키는 두 가지 **다른** 동작을 섞지 않는다:
 *   (a) 허용 밖 키 → 조용히 삭제 (프런트 임시 상태 때문에 저장이 통째로 실패하면 안 된다)
 *   (b) `on` · `html` · `script` · `style` 접두사 키 → 거부 (N-10 우회 시도는 눈에 보이게 실패해야 한다)
 */

import { describe, expect, it } from "vitest";
import {
  BLOCK_KINDS,
  MAX_BLOCKS,
  type BlockKind,
  findForbiddenPropKey,
  validateBlock,
  validateBlocks,
} from "../src/blockSchema";

/** 거부 코드만 꺼낸다. 통과했으면 null. */
function rejectCode(input: unknown): string | null {
  const r = validateBlock(input);
  return r.ok ? null : r.code;
}

/** 저장될 props. 거부되면 테스트를 실패시킨다 (조용한 삭제와 거부를 혼동하지 않기 위해). */
function savedProps(input: unknown): Record<string, unknown> {
  const r = validateBlock(input);
  if (!r.ok) throw new Error(`저장될 줄 알았는데 거부됐다: ${r.code}`);
  return r.block.props;
}

function block(kind: BlockKind, props: Record<string, unknown>, position = 0): unknown {
  return { kind, position, props };
}

describe("P-040: 허용 밖 props 키는 조용히 삭제된다 (거부가 아니다)", () => {
  it("프런트 임시 상태가 섞여 와도 저장은 성공하고 그 키만 사라진다", () => {
    const p = savedProps(
      block("intro", { heading: "소개", _dirty: true, draftId: "tmp-1", __typename: "Block", extra: { a: 1 } }),
    );
    expect(p).toEqual({ heading: "소개" });
  });

  it("모든 블록 종류에서 알 수 없는 키는 삭제되고 허용 키는 남는다", () => {
    // 전수. 새 kind 를 추가하면서 allowlist 를 빠뜨리면 여기서 걸린다.
    for (const kind of BLOCK_KINDS) {
      const p = savedProps(block(kind, { heading: "제목", unknownKey: "x", anotherUnknown: 1 }));
      expect(p.heading, `${kind} 의 heading 이 사라졌다`).toBe("제목");
      expect(Object.keys(p), `${kind} 에 알 수 없는 키가 저장됐다`).toEqual(["heading"]);
    }
  });

  it("값이 spec 모양과 다르면 그 키만 버린다", () => {
    expect(savedProps(block("contact", { heading: "문의", showEmail: "true", showPhone: 1 }))).toEqual({
      heading: "문의",
    });
    expect(savedProps(block("badges", { heading: "검증", layout: "carousel" }))).toEqual({ heading: "검증" });
    expect(savedProps(block("badges", { heading: "검증", layout: "grid" }))).toEqual({
      heading: "검증",
      layout: "grid",
    });
  });

  it("sanitize 후 빈 문자열이 되는 텍스트는 키 자체가 저장되지 않는다", () => {
    const p = savedProps(block("intro", { heading: "<script>alert(1)</script>", body: "   " }));
    expect("heading" in p).toBe(false);
    expect("body" in p).toBe(false);
  });
});

describe("P-040 / N-10: on*·html·script·style 접두사 키는 거부된다 (삭제가 아니다)", () => {
  const FORBIDDEN_KEYS: readonly string[] = [
    "onclick",
    "onClick",
    "ONCLICK",
    "onerror",
    "onload",
    "onmouseover",
    "html",
    "htmlBody",
    "htmlContent",
    "HTML",
    "script",
    "scriptSrc",
    "Script",
    "style",
    "styleOverride",
    "STYLE",
  ];

  it("금지 접두사 키가 하나라도 있으면 forbidden_prop_key 로 거부한다", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(rejectCode(block("intro", { heading: "소개", [key]: "alert(1)" })), `키 '${key}'`).toBe(
        "forbidden_prop_key",
      );
    }
  });

  it("모든 블록 종류에서 거부된다 (한 종류만 막으면 우회된다)", () => {
    for (const kind of BLOCK_KINDS) {
      expect(rejectCode(block(kind, { onclick: "alert(1)" })), `${kind}`).toBe("forbidden_prop_key");
      expect(rejectCode(block(kind, { html: "<b>x</b>" })), `${kind}`).toBe("forbidden_prop_key");
    }
  });

  it("중첩 구조 안쪽(items[])까지 재귀로 찾아 거부한다", () => {
    expect(
      rejectCode(
        block("links", { items: [{ label: "정상", url: "https://example.com" }, { label: "x", onclick: "alert(1)" }] }),
      ),
    ).toBe("forbidden_prop_key");

    expect(rejectCode(block("faq", { items: [{ q: "질문", a: "답변", style: "color:red" }] }))).toBe(
      "forbidden_prop_key",
    );

    // allowlist 가 어차피 버릴 자리에 있어도 거부가 먼저다 — 시도 자체가 신호다.
    expect(rejectCode(block("specialties", { unknownKey: { nested: { deeper: { onload: 1 } } } }))).toBe(
      "forbidden_prop_key",
    );
  });

  it("findForbiddenPropKey 는 문제 위치를 경로로 돌려준다 (사용자에게 설명 가능해야 한다)", () => {
    expect(findForbiddenPropKey({ items: [{ label: "a", onclick: "x" }] })).toBe("props.items[0].onclick");
    expect(findForbiddenPropKey({ a: { b: { c: { html: 1 } } } })).toBe("props.a.b.c.html");
    expect(findForbiddenPropKey([{ x: 1 }, { scriptSrc: 2 }])).toBe("props[1].scriptSrc");
  });

  it("findForbiddenPropKey 는 안전한 값에 대해 null 이다", () => {
    expect(findForbiddenPropKey({ heading: "제목", items: [{ q: "질문", a: "답변" }] })).toBeNull();
    expect(findForbiddenPropKey(null)).toBeNull();
    expect(findForbiddenPropKey("onclick")).toBeNull(); // 값이 아니라 **키 이름**만 본다
    expect(findForbiddenPropKey(42)).toBeNull();
    expect(findForbiddenPropKey([])).toBeNull();
  });
});

describe("P-040 / N-8: metrics 블록에 수치를 담을 수 없다 (보안정책 §4.8)", () => {
  it("value·unit·기간을 보내도 저장되지 않는다 — 지표 코드만 남는다", () => {
    // 여기에 value/unit 이 저장되면 기간·분모·제외조건 없는 수치가 공개되어 N-8 이 깨진다.
    const p = savedProps(
      block("metrics", {
        heading: "성과",
        metricCodes: ["deal_count"],
        value: 128,
        unit: "건",
        period: "2026",
        sampleSize: 30,
        basis: "자체집계",
      }),
    );
    expect(p).toEqual({ heading: "성과", metricCodes: ["deal_count"] });
    for (const forbiddenByDesign of ["value", "unit", "period", "sampleSize", "basis"]) {
      expect(forbiddenByDesign in p, `${forbiddenByDesign} 가 저장됐다`).toBe(false);
    }
  });

  it("note 는 안내문이므로 허용하되 sanitize 를 거친다", () => {
    const p = savedProps(block("metrics", { metricCodes: ["deal_count"], note: "<b>최근 1년</b>" }));
    expect(p.note).toBe("최근 1년");
  });
});

describe("P-040: props 문자열은 sanitize 를 통과한 값만 저장된다", () => {
  it("heading·body 의 마크업이 제거된다", () => {
    const p = savedProps(block("intro", { heading: "<b>김도윤</b>", body: "소개<script>alert(1)</script>본문" }));
    expect(p.heading).toBe("김도윤");
    expect(p.body).toBe("소개 본문");
  });

  it("길이 상한을 넘는 텍스트는 거부가 아니라 잘린다", () => {
    const p = savedProps(block("intro", { heading: "가".repeat(200) }));
    expect(Array.from(String(p.heading))).toHaveLength(80);
  });

  it("textList 의 각 항목도 sanitize 되고 상한을 넘으면 버린다", () => {
    const p = savedProps(
      block("specialties", { items: ["<script>x</script>유통", "   ", 42, null, "인증", "a".repeat(100)] }),
    );
    expect(p.items).toEqual(["유통", "인증", "a".repeat(60)]);
  });

  it("textList 의 개수 상한을 넘으면 앞에서부터 상한만큼만 남는다", () => {
    const many = Array.from({ length: 30 }, (_, i) => `분야${i}`);
    expect(savedProps(block("specialties", { items: many })).items).toHaveLength(20);
    expect(savedProps(block("badges", { badgeTypes: many })).badgeTypes).toHaveLength(12);
    expect(savedProps(block("metrics", { metricCodes: many })).metricCodes).toHaveLength(8);
  });

  it("남는 항목이 없으면 키 자체가 사라진다", () => {
    expect("items" in savedProps(block("specialties", { items: [] }))).toBe(false);
    expect("items" in savedProps(block("specialties", { items: ["   ", "<br/>"] }))).toBe(false);
    expect("items" in savedProps(block("specialties", { items: "분야" }))).toBe(false); // 배열이 아니면 버린다
  });
});

describe("P-040 / P-033: 위험한 url 항목은 떨어진다", () => {
  it("imageUrl 이 http(s) 가 아니면 키가 사라진다 (빈 링크로 남기지 않는다)", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "/p/kim", ""]) {
      const p = savedProps(block("intro", { heading: "소개", imageUrl: bad }));
      expect("imageUrl" in p, `URL ${JSON.stringify(bad)} 가 저장됐다`).toBe(false);
    }
  });

  it("imageUrl 은 정규화된 값으로 저장된다", () => {
    expect(savedProps(block("intro", { imageUrl: "HTTPS://CDN.EXAMPLE.COM/a.png" })).imageUrl).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("링크 목록에서 **문제 항목만** 떨어지고 나머지는 살아남는다", () => {
    const p = savedProps(
      block("links", {
        items: [
          { label: "위험", url: "javascript:alert(1)" },
          { label: "정상", url: "https://example.com/a" },
          { label: "라벨만" },
          { url: "https://example.com/b" },
          { label: "데이터", url: "data:text/html,<script>x</script>" },
        ],
      }),
    );
    expect(p.items).toEqual([{ label: "정상", url: "https://example.com/a" }]);
  });

  it("모든 링크가 떨어지면 items 키가 사라진다", () => {
    const p = savedProps(block("links", { heading: "링크", items: [{ label: "x", url: "javascript:1" }] }));
    expect(p).toEqual({ heading: "링크" });
  });

  it("FAQ 는 질문·답변이 모두 남아야 항목이 저장된다", () => {
    const p = savedProps(
      block("faq", {
        items: [
          { q: "질문1", a: "답변1" },
          { q: "질문만" },
          { a: "답변만" },
          { q: "<script>alert(1)</script>", a: "답변3" }, // q 가 sanitize 후 비어 떨어진다
          { q: "질문5", a: "답변5", unknown: "x" }, // 알 수 없는 필드는 조용히 삭제
        ],
      }),
    );
    expect(p.items).toEqual([
      { q: "질문1", a: "답변1" },
      { q: "질문5", a: "답변5" },
    ]);
  });
});

describe("P-040: kind 와 position 경계", () => {
  it("BLOCK_KINDS 밖의 kind 는 거부한다", () => {
    for (const kind of ["video", "embed", "iframe", "html", "script", "custom", "testimonials", "Intro", "INTRO", ""]) {
      expect(rejectCode({ kind, position: 0, props: {} }), `kind='${kind}'`).toBe("unknown_block_kind");
    }
  });

  it("kind 가 문자열이 아니면 거부한다", () => {
    for (const kind of [undefined, null, 1, true, ["intro"], { kind: "intro" }]) {
      expect(rejectCode({ kind, position: 0, props: {} }), `kind=${JSON.stringify(kind)}`).toBe("unknown_block_kind");
    }
  });

  it("position 은 0 이상 999 이하의 정수여야 한다", () => {
    expect(rejectCode(block("intro", {}, 0))).toBeNull();
    expect(rejectCode(block("intro", {}, 999))).toBeNull();
    expect(rejectCode(block("intro", {}, -1))).toBe("invalid_position");
    expect(rejectCode(block("intro", {}, 1000))).toBe("invalid_position");
    expect(rejectCode(block("intro", {}, 1.5))).toBe("invalid_position");
    expect(rejectCode(block("intro", {}, Number.NaN))).toBe("invalid_position");
    expect(rejectCode(block("intro", {}, Number.POSITIVE_INFINITY))).toBe("invalid_position");
    expect(rejectCode({ kind: "intro", position: "0", props: {} })).toBe("invalid_position");
    expect(rejectCode({ kind: "intro", props: {} })).toBe("invalid_position");
  });

  it("블록·props 가 객체가 아니면 거부한다", () => {
    for (const bad of [null, undefined, "intro", 1, true, []]) {
      expect(rejectCode(bad), `입력 ${JSON.stringify(bad)}`).toBe("block_not_object");
    }
    for (const bad of [null, "x", 1, true, ["heading"]]) {
      expect(rejectCode({ kind: "intro", position: 0, props: bad }), `props=${JSON.stringify(bad)}`).toBe(
        "props_not_object",
      );
    }
  });

  it("props 를 생략하면 빈 객체로 저장된다 (블록만 꽂아 두는 것은 정상이다)", () => {
    const r = validateBlock({ kind: "intro", position: 0 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.block.props).toEqual({});
  });

  it("visible 은 명시하지 않으면 true, 불리언이 아니면 true 로 접힌다", () => {
    const def = validateBlock({ kind: "intro", position: 0 });
    expect(def.ok && def.block.visible).toBe(true);
    const off = validateBlock({ kind: "intro", position: 0, visible: false });
    expect(off.ok && off.block.visible).toBe(false);
    const junk = validateBlock({ kind: "intro", position: 0, visible: "no" });
    expect(junk.ok && junk.block.visible).toBe(true);
  });
});

describe("P-040: 블록 목록 (validateBlocks)", () => {
  function list(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) => block("intro", { heading: `블록${i}` }, i));
  }

  it(`경계: ${MAX_BLOCKS}개는 허용하고 ${MAX_BLOCKS + 1}개는 거부한다`, () => {
    const okResult = validateBlocks(list(MAX_BLOCKS));
    expect(okResult.ok).toBe(true);
    expect(okResult.ok && okResult.blocks).toHaveLength(MAX_BLOCKS);

    const over = validateBlocks(list(MAX_BLOCKS + 1));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.code).toBe("too_many_blocks");
  });

  it("position 중복은 거부하고 어느 값이 겹쳤는지 알려준다", () => {
    const r = validateBlocks([block("intro", {}, 3), block("badges", {}, 3)]);
    expect(r.ok === false && r.code).toBe("duplicate_position");
    expect(r.ok === false && r.message).toContain("3");
  });

  it("position 이 순서대로가 아니어도 중복만 아니면 허용한다", () => {
    const r = validateBlocks([block("intro", {}, 10), block("badges", {}, 2), block("faq", {}, 7)]);
    expect(r.ok).toBe(true);
  });

  it("몇 번째 블록이 문제인지 메시지에 담는다", () => {
    const r = validateBlocks([block("intro", {}, 0), { kind: "video", position: 1, props: {} }]);
    expect(r.ok === false && r.code).toBe("unknown_block_kind");
    expect(r.ok === false && r.message.startsWith("2번째 블록:")).toBe(true);
  });

  it("목록 안의 금지 키도 거부된다 (한 블록이 전체 저장을 막는다)", () => {
    const r = validateBlocks([block("intro", { heading: "소개" }, 0), block("faq", { onclick: "x" }, 1)]);
    expect(r.ok === false && r.code).toBe("forbidden_prop_key");
  });

  it("배열이 아니면 거부한다", () => {
    for (const bad of [null, undefined, {}, "[]", 1]) {
      const r = validateBlocks(bad);
      expect(r.ok === false && r.code, `입력 ${JSON.stringify(bad)}`).toBe("blocks_not_array");
    }
  });

  it("빈 목록은 허용한다 (블록을 모두 지우는 것은 정상 편집이다)", () => {
    const r = validateBlocks([]);
    expect(r.ok && r.blocks).toEqual([]);
  });
});
