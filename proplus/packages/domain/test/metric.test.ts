/**
 * P-066 측정 지표 등록 · P-067 거래 수치는 연동 증거만
 *
 * 전략 §2 의 **N-8** 을 지키는 테스트다 (보안정책 §4.8 / 브랜드 §5).
 * "누적 643건" 처럼 기간·분모·근거가 없는 숫자는 가장 잘 팔리는 문구이고 가장 검증되지 않은 문구다.
 * DB 의 NOT NULL 은 빈 문자열과 표본 0 을 통과시키므로 여기서 거부하는 것이 유일한 방어선이다.
 */

import { describe, expect, it } from "vitest";
import {
  type MetricClaimInput,
  type MetricResult,
  formatMetricDisclosure,
  isVerifiableMetric,
  validateMetricClaim,
} from "../src/metric";
import { VERIFICATION_METHODS } from "../src/types";

/** 수용기준(보안정책 §4.8)을 모두 만족하는 최소 입력. 각 테스트가 필요한 것만 덮어쓴다. */
function claim(over: Partial<MetricClaimInput> = {}): MetricClaimInput {
  return {
    metricCode: "deal_count",
    value: 643,
    unit: "건",
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
    sampleSize: 128,
    basis: "사내 CRM 성약 기준, 취소 건 제외",
    method: "system_integrated",
    ...over,
  };
}

function code(r: MetricResult): string | null {
  return r.ok ? null : r.code;
}

describe("P-066 / N-8: 네 요소(기간·표본·근거·단위)가 모두 있어야 저장된다", () => {
  it("완전한 지표는 통과한다", () => {
    expect(validateMetricClaim(claim()).ok).toBe(true);
  });

  it("basis 가 빈 문자열이면 거부한다 — NOT NULL 을 통과하는 구멍이다", () => {
    expect(code(validateMetricClaim(claim({ basis: "" })))).toBe("basis_required");
  });

  it("basis 가 공백뿐이면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ basis: "   " })))).toBe("basis_required");
    expect(code(validateMetricClaim(claim({ basis: "\t\n " })))).toBe("basis_required");
  });

  it("basis 가 누락되면 거부한다", () => {
    const broken = { ...claim(), basis: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(broken))).toBe("basis_required");
  });

  it("표본 수 0 은 거부한다 — '측정하지 않았다'와 같다", () => {
    expect(code(validateMetricClaim(claim({ sampleSize: 0 })))).toBe("sample_size_required");
  });

  it("표본 수가 음수면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ sampleSize: -1 })))).toBe("sample_size_required");
    expect(code(validateMetricClaim(claim({ sampleSize: -128 })))).toBe("sample_size_required");
  });

  it("표본 수가 NaN/Infinity/누락이면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ sampleSize: Number.NaN })))).toBe("sample_size_required");
    expect(code(validateMetricClaim(claim({ sampleSize: Number.POSITIVE_INFINITY })))).toBe("sample_size_required");
    const broken = { ...claim(), sampleSize: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(broken))).toBe("sample_size_required");
  });

  it("경계: 표본 1 은 통과한다 (하한은 1 이다)", () => {
    expect(validateMetricClaim(claim({ sampleSize: 1 })).ok).toBe(true);
  });

  it("metricCode 가 비면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ metricCode: "" })))).toBe("metric_code_required");
    expect(code(validateMetricClaim(claim({ metricCode: "  " })))).toBe("metric_code_required");
    const broken = { ...claim(), metricCode: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(broken))).toBe("metric_code_required");
  });

  it("단위가 비면 거부한다 — 643 이 건수인지 억원인지 알 수 없다", () => {
    expect(code(validateMetricClaim(claim({ unit: "" })))).toBe("unit_required");
    expect(code(validateMetricClaim(claim({ unit: " " })))).toBe("unit_required");
    const broken = { ...claim(), unit: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(broken))).toBe("unit_required");
  });

  it("value 가 NaN/Infinity/-Infinity/누락이면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ value: Number.NaN })))).toBe("value_invalid");
    expect(code(validateMetricClaim(claim({ value: Number.POSITIVE_INFINITY })))).toBe("value_invalid");
    expect(code(validateMetricClaim(claim({ value: Number.NEGATIVE_INFINITY })))).toBe("value_invalid");
    const missing = { ...claim(), value: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(missing))).toBe("value_invalid");
    const str = { ...claim(), value: "643" } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(str))).toBe("value_invalid");
  });

  it("value 0 은 유효하다 — 0 건도 측정 결과다", () => {
    expect(validateMetricClaim(claim({ value: 0 })).ok).toBe(true);
  });
});

describe("P-066 / N-8: 측정 기간은 실제 달력 날짜여야 하고 거꾸로 갈 수 없다", () => {
  it("periodEnd 가 periodStart 보다 앞서면 거부한다", () => {
    expect(code(validateMetricClaim(claim({ periodStart: "2026-06-30", periodEnd: "2026-01-01" })))).toBe(
      "period_order_invalid",
    );
  });

  it("경계: 하루 차이로 뒤집힌 기간도 거부한다", () => {
    expect(code(validateMetricClaim(claim({ periodStart: "2026-01-02", periodEnd: "2026-01-01" })))).toBe(
      "period_order_invalid",
    );
  });

  it("경계: 시작일과 종료일이 같으면 통과한다 (하루 측정)", () => {
    expect(validateMetricClaim(claim({ periodStart: "2026-01-01", periodEnd: "2026-01-01" })).ok).toBe(true);
  });

  it("날짜 형식이 아니면 period_invalid 다", () => {
    for (const bad of ["", "   ", "nonsense", "2026/01/01", "2026-1-1", "01-01-2026", "20260101"]) {
      expect(code(validateMetricClaim(claim({ periodStart: bad }))), `${bad} 가 통과했다`).toBe("period_invalid");
      expect(code(validateMetricClaim(claim({ periodEnd: bad }))), `${bad} 가 통과했다`).toBe("period_invalid");
    }
  });

  it("달력에 없는 날짜는 거부한다 — 로컬 파싱 롤오버로 하루 밀리는 것을 막는다", () => {
    for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-01-32", "2026-04-31"]) {
      expect(code(validateMetricClaim(claim({ periodEnd: bad }))), `${bad} 가 통과했다`).toBe("period_invalid");
    }
  });

  it("윤년 2월 29일은 유효하다", () => {
    expect(validateMetricClaim(claim({ periodStart: "2028-02-29", periodEnd: "2028-03-01" })).ok).toBe(true);
  });

  it("날짜가 누락되면 거부한다", () => {
    const broken = { ...claim(), periodStart: undefined } as unknown as MetricClaimInput;
    expect(code(validateMetricClaim(broken))).toBe("period_invalid");
  });
});

describe("P-067: 거래 수치는 system_integrated 증거만 검증으로 인정한다 (기획서 §7)", () => {
  it("전수: VERIFICATION_METHODS 중 system_integrated 만 true 다", () => {
    for (const m of VERIFICATION_METHODS) {
      expect(isVerifiableMetric(m), `${m} 의 판정이 바뀌었다`).toBe(m === "system_integrated");
    }
  });

  it("method 가 없으면(자기기재) false 다 — 직접 입력 수치는 검증 배지를 받지 못한다", () => {
    expect(isVerifiableMetric(null)).toBe(false);
    expect(isVerifiableMetric(undefined)).toBe(false);
  });

  it("배지 일반 규칙보다 좁다 — document_reviewed·issuer_confirmed 도 거래 수치에는 부족하다", () => {
    // badge.ts 는 self_declared 만 막지만, 집계 수치는 '그 시점의 서류 한 장'으로 확인되지 않는다.
    expect(isVerifiableMetric("document_reviewed")).toBe(false);
    expect(isVerifiableMetric("issuer_confirmed")).toBe(false);
  });

  it("알 수 없는 method 문자열도 false 다 (fail-closed)", () => {
    expect(isVerifiableMetric("admin_override" as unknown as (typeof VERIFICATION_METHODS)[number])).toBe(false);
  });
});

describe("P-066 / N-8: 공개 문구는 기간·표본·근거를 모두 담는다 (수치만 노출 금지)", () => {
  const cases: MetricClaimInput[] = [
    claim(),
    claim({ periodStart: "2025-03-01", periodEnd: "2025-03-31", sampleSize: 7, basis: "자사 접수 기준, 반려 제외" }),
    claim({ metricCode: "response_minutes", value: 12, unit: "분", sampleSize: 1, basis: "영업시간 내 최초 응답" }),
  ];

  it("기간 시작·종료가 문구에 들어간다", () => {
    for (const i of cases) {
      const s = formatMetricDisclosure(i);
      expect(s, `${i.metricCode}: 시작일이 빠졌다`).toContain(i.periodStart);
      expect(s, `${i.metricCode}: 종료일이 빠졌다`).toContain(i.periodEnd);
    }
  });

  it("표본 수가 문구에 들어간다", () => {
    for (const i of cases) {
      expect(formatMetricDisclosure(i), `${i.metricCode}: 표본이 빠졌다`).toContain(`표본 ${i.sampleSize}`);
    }
  });

  it("산정 근거가 원문 그대로 문구에 들어간다", () => {
    for (const i of cases) {
      expect(formatMetricDisclosure(i), `${i.metricCode}: 근거가 빠졌다`).toContain(i.basis);
    }
  });

  it("문구가 수치만으로 끝나는 경로가 없다", () => {
    const s = formatMetricDisclosure(claim());
    expect(s).not.toBe("643");
    expect(s).not.toBe("643건");
    // 세 요소가 구분자로 함께 붙어 있어야 한다 — 렌더러가 잘라 쓸 수 없게 한 줄이다.
    expect(s.split("·").length).toBeGreaterThanOrEqual(3);
  });

  it("날짜는 YYYY-MM-DD 로 정규화돼 나온다", () => {
    expect(formatMetricDisclosure(claim({ periodStart: "2026-01-01", periodEnd: "2026-06-30" }))).toContain(
      "2026-01-01~2026-06-30",
    );
  });

  it("표본이 1 이어도 표본 문구를 생략하지 않는다", () => {
    expect(formatMetricDisclosure(claim({ sampleSize: 1 }))).toContain("표본 1건");
  });
});
