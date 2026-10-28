/**
 * P-008 동의 기록 (종류별 분리) · P-101 리드 생성 시 동의 분리 기록
 *
 * 전략 §2 의 **N-11** 을 지키는 테스트다 (모듈명세 M07 / 보안정책 §3 목적 제한).
 * 이 파일의 존재 이유는 한 줄로 요약된다 — `REQUIRED_FOR_LEAD` 에 'marketing' 이 들어가는 순간
 * 마케팅 수신 동의가 상담 처리의 **조건**이 되고, 그러면 동의가 동의가 아니게 된다.
 * 누가 그 PR 을 올리면 아래 첫 describe 에서 터져야 한다.
 */

import { describe, expect, it } from "vitest";
import {
  REQUIRED_FOR_LEAD,
  type ConsentInput,
  type ConsentRecordLike,
  type ConsentResult,
  hasConsent,
  separateConsents,
  validateLeadConsents,
} from "../src/consent";
import { CONSENT_PURPOSES, type ConsentPurpose } from "../src/types";

const POLICY = "2026-10-01";

function c(purpose: ConsentPurpose, granted: boolean, policyVersion: string = POLICY): ConsentInput {
  return { purpose, granted, policyVersion };
}

/** 거부 코드만 꺼낸다. 통과면 null — `expect(code(r)).toBe(...)` 로 의도를 그대로 읽게 하려는 것이다. */
function code(r: ConsentResult): string | null {
  return r.ok ? null : r.code;
}

describe("P-101 / N-11: marketing 은 리드 생성의 필수 동의가 아니다 (보안정책 §3)", () => {
  it("REQUIRED_FOR_LEAD 에 'marketing' 이 없다 — 이 단정이 N-11 의 전부다", () => {
    expect(REQUIRED_FOR_LEAD).not.toContain("marketing");
  });

  it("필수는 'service' 하나뿐이고 나머지 네 목적은 전부 선택이다", () => {
    // 전수: 새 purpose 가 enum 에 추가되더라도 "필수"로 조용히 승격되지 않는지 확인한다.
    for (const p of CONSENT_PURPOSES) {
      expect(REQUIRED_FOR_LEAD.includes(p), `${p} 의 필수 여부가 바뀌었다`).toBe(p === "service");
    }
    expect(REQUIRED_FOR_LEAD).toEqual(["service"]);
  });

  it("service 외의 어떤 목적을 거부해도 리드 생성은 통과한다", () => {
    for (const p of CONSENT_PURPOSES) {
      if (p === "service") continue;
      const r = validateLeadConsents([c("service", true), c(p, false)]);
      expect(r.ok, `${p} 거부가 리드 생성을 막았다`).toBe(true);
    }
  });

  it("marketing 을 아예 보내지 않아도 통과한다 — 보내지 않은 선택 동의는 거부와 같다", () => {
    expect(validateLeadConsents([c("service", true)]).ok).toBe(true);
  });

  it("marketing=true 를 함께 보내도 통과한다 (선택 동의는 받아도 된다)", () => {
    expect(validateLeadConsents([c("service", true), c("marketing", true)]).ok).toBe(true);
  });
});

describe("P-101 / N-11: service 동의가 없으면 리드를 만들 수 없다", () => {
  it("service 를 보내지 않으면 consent_required 로 거부한다", () => {
    expect(code(validateLeadConsents([c("marketing", true)]))).toBe("consent_required");
  });

  it("service=false 면 거부한다 — 체크를 해제한 것은 동의가 아니다", () => {
    expect(code(validateLeadConsents([c("service", false)]))).toBe("consent_required");
  });

  it("service=false + marketing=true 는 거부한다 (선택 동의가 필수를 대체하지 못한다)", () => {
    expect(code(validateLeadConsents([c("service", false), c("marketing", true)]))).toBe("consent_required");
  });

  it("빈 배열은 거부한다", () => {
    expect(code(validateLeadConsents([]))).toBe("consent_required");
  });

  it("다섯 목적을 모두 동의하면 통과한다", () => {
    const all = CONSENT_PURPOSES.map((p) => c(p, true));
    expect(validateLeadConsents(all).ok).toBe(true);
  });
});

describe("P-008: 동의 기록은 재현 가능해야 한다 — policy_version 필수 (P-169)", () => {
  it("policyVersion 이 빈 문자열이면 거부한다", () => {
    expect(code(validateLeadConsents([c("service", true, "")]))).toBe("policy_version_required");
  });

  it("policyVersion 이 공백뿐이면 거부한다", () => {
    expect(code(validateLeadConsents([c("service", true, "   ")]))).toBe("policy_version_required");
  });

  it("policyVersion 이 누락(undefined)되면 거부한다 — HTTP 본문은 타입을 지키지 않는다", () => {
    const broken = { purpose: "service", granted: true } as unknown as ConsentInput;
    expect(code(validateLeadConsents([broken]))).toBe("policy_version_required");
  });

  it("선택 동의에도 policyVersion 을 요구한다 — 기록으로서 값이 없는 동의는 저장하지 않는다", () => {
    const r = validateLeadConsents([c("service", true), c("marketing", false, "")]);
    expect(code(r)).toBe("policy_version_required");
  });
});

describe("P-008: 알 수 없는 목적과 상충하는 동의는 거부한다", () => {
  it("consent_purpose enum 밖의 값은 unknown_consent_purpose 다", () => {
    const bogus = { purpose: "analytics", granted: true, policyVersion: POLICY } as unknown as ConsentInput;
    expect(code(validateLeadConsents([bogus]))).toBe("unknown_consent_purpose");
  });

  it("service 가 함께 와도 알 수 없는 목적이 있으면 거부한다 — 부분 저장을 허용하지 않는다", () => {
    const bogus = { purpose: "", granted: true, policyVersion: POLICY } as unknown as ConsentInput;
    expect(code(validateLeadConsents([c("service", true), bogus]))).toBe("unknown_consent_purpose");
  });

  it("같은 목적에 true 와 false 가 함께 오면 consent_conflict 로 거부한다", () => {
    // 임의로 true 로 해석해 저장하는 것이 가장 위험하다. 어느 쪽도 고르지 않는다.
    expect(code(validateLeadConsents([c("service", true), c("service", false)]))).toBe("consent_conflict");
    expect(code(validateLeadConsents([c("service", false), c("service", true)]))).toBe("consent_conflict");
  });

  it("선택 목적(marketing)의 상충도 거부한다", () => {
    const r = validateLeadConsents([c("service", true), c("marketing", true), c("marketing", false)]);
    expect(code(r)).toBe("consent_conflict");
  });

  it("같은 목적이 같은 값으로 두 번 와도 통과한다 — 중복은 모순이 아니다", () => {
    expect(validateLeadConsents([c("service", true), c("service", true)]).ok).toBe(true);
  });
});

describe("P-008: hasConsent 는 가장 최근 기록을 따른다 — 철회가 이긴다", () => {
  const T1 = "2026-01-01T00:00:00.000Z";
  const T2 = "2026-06-01T00:00:00.000Z";
  const T3 = "2026-10-01T00:00:00.000Z";

  it("동의 → 철회 순이면 false 다 (하나라도 true 면 true 가 아니다)", () => {
    const rows: ConsentRecordLike[] = [
      { purpose: "marketing", granted: true, createdAt: T1 },
      { purpose: "marketing", granted: false, createdAt: T2 },
    ];
    expect(hasConsent(rows, "marketing")).toBe(false);
  });

  it("동의 → 철회 → 재동의면 true 다", () => {
    const rows: ConsentRecordLike[] = [
      { purpose: "marketing", granted: true, createdAt: T1 },
      { purpose: "marketing", granted: false, createdAt: T2 },
      { purpose: "marketing", granted: true, createdAt: T3 },
    ];
    expect(hasConsent(rows, "marketing")).toBe(true);
  });

  it("배열 순서가 시간 순이 아니어도 createdAt 이 이긴다", () => {
    const rows: ConsentRecordLike[] = [
      { purpose: "marketing", granted: false, createdAt: T3 },
      { purpose: "marketing", granted: true, createdAt: T1 },
    ];
    expect(hasConsent(rows, "marketing")).toBe(false);
  });

  it("createdAt 이 없으면 배열 순서를 시간 축으로 쓴다 (뒤가 최근)", () => {
    expect(
      hasConsent(
        [
          { purpose: "service", granted: true },
          { purpose: "service", granted: false },
        ],
        "service",
      ),
    ).toBe(false);
    expect(
      hasConsent(
        [
          { purpose: "service", granted: false },
          { purpose: "service", granted: true },
        ],
        "service",
      ),
    ).toBe(true);
  });

  it("시각이 같으면 뒤에 온 기록을 따른다 — 모호한 경계에서 철회 쪽을 고른다", () => {
    const rows: ConsentRecordLike[] = [
      { purpose: "marketing", granted: true, createdAt: T1 },
      { purpose: "marketing", granted: false, createdAt: T1 },
    ];
    expect(hasConsent(rows, "marketing")).toBe(false);
  });

  it("다른 목적의 동의는 영향을 주지 않는다 — 목적 제한의 핵심이다", () => {
    const rows: ConsentRecordLike[] = [{ purpose: "service", granted: true, createdAt: T1 }];
    for (const p of CONSENT_PURPOSES) {
      expect(hasConsent(rows, p), `${p} 가 service 동의로 열렸다`).toBe(p === "service");
    }
  });

  it("기록이 아예 없으면 false 다 (기본값은 비동의)", () => {
    for (const p of CONSENT_PURPOSES) {
      expect(hasConsent([], p)).toBe(false);
    }
  });

  it("파싱 불가한 createdAt 은 배열 순서로 대체 판정한다", () => {
    const rows: ConsentRecordLike[] = [
      { purpose: "marketing", granted: true, createdAt: "nonsense" },
      { purpose: "marketing", granted: false, createdAt: null },
    ];
    expect(hasConsent(rows, "marketing")).toBe(false);
  });

  it("granted 가 true 가 아닌 값이면 동의로 보지 않는다", () => {
    const rows = [{ purpose: "marketing", granted: "true" }] as unknown as ConsentRecordLike[];
    expect(hasConsent(rows, "marketing")).toBe(false);
  });
});

describe("P-101 / N-11: separateConsents 가 필수와 선택을 가른다 (M07 수용기준)", () => {
  it("service 만 필수 묶음에 들어간다", () => {
    const inputs = CONSENT_PURPOSES.map((p) => c(p, true));
    const { required, optional } = separateConsents(inputs);
    expect(required.map((x) => x.purpose)).toEqual(["service"]);
    expect(optional.map((x) => x.purpose)).toEqual(["privacy", "marketing", "verification", "recording"]);
  });

  it("전수: 각 목적이 정확히 한쪽 묶음에만 들어간다", () => {
    for (const p of CONSENT_PURPOSES) {
      const { required, optional } = separateConsents([c(p, true)]);
      expect(required.length + optional.length, `${p} 가 사라졌거나 중복됐다`).toBe(1);
      expect(required.length === 1, `${p} 가 잘못된 묶음에 있다`).toBe(p === "service");
    }
  });

  it("marketing 은 어떤 경우에도 필수 묶음에 들어가지 않는다", () => {
    const { required } = separateConsents([c("marketing", true), c("marketing", false, "v2")]);
    expect(required).toEqual([]);
  });

  it("빈 입력은 두 묶음 모두 비어 있다", () => {
    expect(separateConsents([])).toEqual({ required: [], optional: [] });
  });

  it("입력 객체를 그대로 넘겨준다 — UI 가 policyVersion 을 다시 조회하지 않아도 된다", () => {
    const input = c("marketing", false, "2026-09-01");
    const { optional } = separateConsents([input]);
    expect(optional[0]).toBe(input);
  });
});
