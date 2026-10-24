/**
 * P-102 연락처 암호화 저장 — 수용 기준: "전화·이메일은 저장 시 암호화하고 **목록 화면에는 마스킹만** 보인다".
 *
 * 마스킹은 리댁션(N-13)과 목적이 다르다 — 담당자가 "같은 사람인지" 알아볼 수 있어야 하므로
 * 도메인·앞뒤 일부를 남긴다. 그래서 이 파일의 단정은 두 방향을 같이 본다:
 *   (1) 식별에 필요한 조각이 남는가,  (2) **원문이 복원되지 않는가**.
 * 원문 공개는 별도 권한·감사로그 경로(P-104)이고 이 함수의 책임이 아니다.
 */

import { describe, expect, it } from "vitest";
import { maskContact, type ContactKind } from "../src/mask";
import { maskEmail, maskPhone } from "../src/redact";

const CONTACT_KINDS: readonly ContactKind[] = ["email", "phone"];

describe("P-102: maskEmail — 로컬파트는 가리고 도메인은 남긴다", () => {
  it("앞 2자만 남기고 로컬파트의 나머지를 지운다", () => {
    expect(maskEmail("abcdef@example.com")).toBe("ab***@example.com");
  });

  it("도메인은 보존한다 — 담당자가 어느 조직인지 알아야 응대할 수 있다", () => {
    expect(maskEmail("hong.gildong@hospital.co.kr")).toContain("@hospital.co.kr");
    expect(maskEmail("a.b.c@sub.example.io")).toContain("@sub.example.io");
  });

  it("로컬파트의 3번째 글자부터는 어떤 형태로도 남지 않는다", () => {
    const out = maskEmail("hong.gildong@hospital.co.kr");
    expect(out).not.toContain("gildong");
    expect(out).not.toContain("hong.");
    // '***' 앞에 남는 조각은 최대 2자다.
    expect(out.split("***")[0]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("이메일 모양이 아니면 식별 가능한 조각을 하나도 남기지 않는다", () => {
    for (const bad of ["", "   ", "no-at-sign", "@example.com", "user@", "@"]) {
      expect(maskEmail(bad), `${JSON.stringify(bad)}`).toBe("***");
    }
  });

  it("어떤 입력이든 원문을 그대로 돌려주지 않는다 (아주 짧은 주소 포함)", () => {
    for (const e of ["a@b.c", "ab@x.com", "abcdef@example.com", "x@y.co.kr"]) {
      const out = maskEmail(e);
      expect(out, `${e} 가 그대로 남았다`).not.toBe(e);
      expect(out).toContain("***");
    }
  });

  it("대문자·특수문자를 섞어도 마스킹을 건너뛰지 않는다", () => {
    const out = maskEmail("A.B+tag@Example.COM");
    expect(out).toBe("A.***@Example.COM");
    expect(out).not.toContain("+tag");
  });
});

describe("P-102: maskPhone — 가운데를 가린다", () => {
  it("표기와 무관하게 같은 번호가 같은 마스크로 보인다 (담당자가 동일인을 알아본다)", () => {
    for (const p of ["01012345678", "010-1234-5678", "010 1234 5678", "０１０１２３４５６７８"]) {
      expect(maskPhone(p), `${p}`).toBe("010-****-5678");
    }
  });

  it("가운데 4자리는 남지 않는다", () => {
    const out = maskPhone("010-1234-5678");
    expect(out).not.toContain("1234");
    expect(out).toContain("****");
  });

  it("7자리 미만은 남길 조각이 곧 전부이므로 전체를 가린다", () => {
    for (const p of ["", "abc", "1234", "123456", "02-1234"]) {
      expect(maskPhone(p), `${JSON.stringify(p)}`).toBe("***");
    }
  });

  it("숫자 4자리만 들어와도 원문이 그대로 남지 않는다", () => {
    const out = maskPhone("1234");
    expect(out).toBe("***");
    expect(out).not.toContain("1234");
  });
});

describe("P-102: maskContact — kind 분기", () => {
  it("kind 에 맞는 마스커로 보낸다", () => {
    expect(maskContact("email", "abcdef@example.com")).toBe(maskEmail("abcdef@example.com"));
    expect(maskContact("phone", "010-1234-5678")).toBe(maskPhone("010-1234-5678"));
  });

  it("kind 를 잘못 넘겨도 원문이 새지 않는다 — 분기 오용이 유출로 이어지지 않아야 한다", () => {
    // 이메일을 phone 으로: 숫자가 7자리 미만이므로 전체 마스킹.
    expect(maskContact("phone", "hong@example.com")).toBe("***");
    // 전화를 email 로: '@' 가 없으므로 전체 마스킹.
    expect(maskContact("email", "010-1234-5678")).toBe("***");
  });

  it("kind × 입력 전수: 결과에 원문이 통째로 남는 조합이 없다", () => {
    const values = ["abcdef@example.com", "a@b.c", "010-1234-5678", "01012345678", "1234", ""];
    for (const kind of CONTACT_KINDS) {
      for (const v of values) {
        const out = maskContact(kind, v);
        expect(out, `${kind} / ${JSON.stringify(v)}`).not.toBe(v);
        expect(out).toMatch(/\*/); // 어떤 경로로도 마스킹 표시 없이 나오지 않는다
      }
    }
  });
});

describe("P-102: 짧은 번호 경계 — 마스크가 원문을 복원하지 않는다", () => {
  // `앞3 + 뒤4 = 7` 을 드러내므로 입력이 7~8자리면 마스킹 효과가 0 이거나 음수다.
  // 그래서 maskPhone 의 부분 마스킹 하한은 9(국내 최단 02-123-4567)이고,
  // 그 아래는 전체를 가린다. 이 두 테스트가 그 하한을 고정한다.
  it("7자리 번호는 마스크에서 숫자가 복원되지 않는다", () => {
    const out = maskPhone("1234567");
    expect(out.replace(/\D/g, "")).not.toBe("1234567");
    expect(out).toBe("***");
  });

  it("8자리 번호도 7자리가 드러나지 않는다", () => {
    const out = maskPhone("12345678");
    expect(out.replace(/\D/g, "").length).toBeLessThan(7);
  });

  it("9자리부터 부분 마스킹을 쓴다 (담당자는 식별할 수 있어야 한다)", () => {
    expect(maskPhone("021234567")).toBe("021-****-4567");
    expect(maskPhone("010-1234-5678")).toBe("010-****-5678");
  });
});
