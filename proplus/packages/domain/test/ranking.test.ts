/**
 * P-071 직군 간 단순 순위화 금지 (보안정책 §4.9 / 전략 §11.3).
 *
 * 이 파일이 지키는 약속은 한 문장이다:
 *   비교 불가능한 지표(직군·코드·단위가 다른 것)는 하나의 순위로 합쳐지지 않는다.
 * 깨지면 "단일 신뢰점수를 내지 않는다"(N-3)는 차별점이 뚫린 것이다.
 */

import { describe, expect, it } from "vitest";
import {
  type ComparableMetric,
  type DistributionPosition,
  areComparable,
  assertComparableSet,
  cohortKeyOf,
  distributionWithinCohort,
  groupByCohort,
} from "../src/ranking";

function m(over: Partial<ComparableMetric> = {}): ComparableMetric {
  return { claimId: "c1", cohort: "의료기기유통", metricCode: "contracts_closed", unit: "건", value: 10, ...over };
}

describe("P-071: 비교가능성 키 — (cohort, metricCode, unit) 가 완전히 같아야 비교할 수 있다", () => {
  it("세 축이 모두 같으면 비교 가능하다", () => {
    expect(areComparable(m(), m({ claimId: "c2", value: 99 }))).toBe(true);
  });

  it("직군이 다르면 비교 불가다 — 성약 건수는 직군을 가로질러 뜻이 다르다", () => {
    expect(areComparable(m({ cohort: "법무" }), m({ cohort: "의료기기유통" }))).toBe(false);
  });

  it("지표 코드가 다르면 비교 불가다 — '성약'과 '승소'는 같은 축이 아니다", () => {
    expect(areComparable(m({ metricCode: "contracts_closed" }), m({ metricCode: "cases_won" }))).toBe(false);
  });

  it("단위가 다르면 비교 불가다 — 같은 코드라도 건 vs 억원은 다른 숫자다", () => {
    expect(areComparable(m({ unit: "건" }), m({ unit: "억원" }))).toBe(false);
  });

  it("앞뒤 공백 차이는 같은 모집단으로 접힌다 (정규화)", () => {
    expect(cohortKeyOf(m({ cohort: " 법무 " }))).toBe(cohortKeyOf(m({ cohort: "법무" })));
    expect(areComparable(m({ cohort: " 법무 " }), m({ cohort: "법무" }))).toBe(true);
  });
});

describe("P-071: assertComparableSet — 섞인 집합을 단일 순위로 만들려는 시도를 거부한다 (보안정책 §4.9)", () => {
  it("빈 집합은 통과한다 — 비교할 것이 없으면 규칙을 어길 수도 없다", () => {
    expect(() => assertComparableSet([])).not.toThrow();
  });

  it("하나의 코호트로만 이루어지면 통과한다", () => {
    expect(() => assertComparableSet([m({ claimId: "a", value: 1 }), m({ claimId: "b", value: 2 })])).not.toThrow();
  });

  it("직군이 섞이면 던진다", () => {
    expect(() => assertComparableSet([m({ cohort: "법무" }), m({ cohort: "의료기기유통" })])).toThrow(/P-071/);
  });

  it("지표 코드가 섞이면 던진다", () => {
    expect(() =>
      assertComparableSet([m({ metricCode: "contracts_closed" }), m({ metricCode: "response_time" })]),
    ).toThrow(/P-071/);
  });

  it("단위가 섞이면 던진다", () => {
    expect(() => assertComparableSet([m({ unit: "건" }), m({ unit: "억원" })])).toThrow(/P-071/);
  });

  it("예외 메시지가 근거(보안정책 §4.9)와 섞인 모집단 수를 밝힌다", () => {
    expect(() => assertComparableSet([m({ cohort: "법무" }), m({ cohort: "세무" }), m({ cohort: "노무" })])).toThrow(
      /보안정책 §4\.9.*3개 모집단/,
    );
  });

  it("유한수가 아닌 값은 거부한다 — 비교 자체가 불가능하다", () => {
    expect(() => assertComparableSet([m({ value: Number.NaN })])).toThrow(/P-071/);
    expect(() => assertComparableSet([m({ value: Number.POSITIVE_INFINITY })])).toThrow(/P-071/);
  });
});

describe("P-071: groupByCohort — 섞인 집합은 직군별로 나눠 각 직군 안에서만 다루게 한다", () => {
  it("비교가능성 키별로 분할하고 개수를 보존한다", () => {
    const claims = [
      m({ claimId: "a", cohort: "법무" }),
      m({ claimId: "b", cohort: "의료기기유통" }),
      m({ claimId: "c", cohort: "법무" }),
    ];
    const groups = groupByCohort(claims);
    expect(groups.size).toBe(2);
    const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
    expect(total).toBe(3);
  });

  it("그룹 안에서 입력 순서를 보존한다 — 순서가 우열을 뜻하지 않지만 응답은 안정적이어야 한다", () => {
    const claims = [
      m({ claimId: "first", cohort: "법무", value: 1 }),
      m({ claimId: "second", cohort: "법무", value: 9 }),
    ];
    const bucket = groupByCohort(claims).get(cohortKeyOf(m({ cohort: "법무" })));
    expect(bucket?.map((c) => c.claimId)).toEqual(["first", "second"]);
  });
});

describe("P-071: distributionWithinCohort — 허락된 유일한 비교는 같은 직군 내 서수뿐 (전략 §11.3)", () => {
  it("직군이 섞여 있으면 분포를 내지 않고 던진다 — 가로지르는 숫자를 만들지 않는다", () => {
    expect(() =>
      distributionWithinCohort([m({ cohort: "법무" }), m({ cohort: "세무" })], { higherIsBetter: true }),
    ).toThrow(/P-071/);
  });

  it("클수록 앞서는 지표: 최대값이 1위다", () => {
    const d = distributionWithinCohort(
      [m({ claimId: "lo", value: 5 }), m({ claimId: "hi", value: 50 }), m({ claimId: "mid", value: 20 })],
      { higherIsBetter: true },
    );
    expect(byId(d, "hi").position).toBe(1);
    expect(byId(d, "mid").position).toBe(2);
    expect(byId(d, "lo").position).toBe(3);
    expect(d.every((p) => p.of === 3)).toBe(true);
  });

  it("작을수록 앞서는 지표(평균 응답시간): 최소값이 1위다", () => {
    const d = distributionWithinCohort(
      [m({ claimId: "slow", metricCode: "response_time", unit: "분", value: 40 }),
       m({ claimId: "fast", metricCode: "response_time", unit: "분", value: 5 })],
      { higherIsBetter: false },
    );
    expect(byId(d, "fast").position).toBe(1);
    expect(byId(d, "slow").position).toBe(2);
  });

  it("동점은 같은 순위를 공유하고 다음을 건너뛴다(1,1,3) — 서수를 점수로 오해하지 않게 한다", () => {
    const d = distributionWithinCohort(
      [m({ claimId: "a", value: 100 }), m({ claimId: "b", value: 100 }), m({ claimId: "c", value: 10 })],
      { higherIsBetter: true },
    );
    expect(byId(d, "a").position).toBe(1);
    expect(byId(d, "b").position).toBe(1);
    expect(byId(d, "c").position).toBe(3);
  });

  it("빈 집합은 빈 분포다", () => {
    expect(distributionWithinCohort([], { higherIsBetter: true })).toEqual([]);
  });

  it("결과에 스칼라 '점수' 필드가 없다 — 서수(position/of)만 노출한다 (N-3)", () => {
    const d = distributionWithinCohort([m({ value: 1 })], { higherIsBetter: true });
    const keys = Object.keys(d[0] as DistributionPosition).sort();
    expect(keys).toEqual(["claimId", "cohort", "metricCode", "of", "position", "unit"].sort());
    expect(keys).not.toContain("score");
  });
});

function byId(d: readonly DistributionPosition[], id: string): DistributionPosition {
  const found = d.find((p) => p.claimId === id);
  if (!found) throw new Error(`테스트 설정 오류: ${id} 없음`);
  return found;
}
