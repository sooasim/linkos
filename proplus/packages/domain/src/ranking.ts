/**
 * P-071: 직군 간 단순 순위화 금지 (보안정책 §4.9 / 전략 §11.3).
 *
 * 이 파일은 `search.ts`(N-15 노출 투명성)·`metric.ts`(N-8 지표 공시)와 같은 계열이다 —
 * **점수를 계산하지 않고, 점수가 생기는 길을 막는다.**
 *
 * 무엇을 막는가:
 *   "김영업은 성약 643건, 이변호사는 승소 12건" 같은 **서로 다른 직군·지표**의 숫자를
 *   하나의 줄 세우기로 합치는 순간, 그것이 곧 단일 신뢰점수다(N-3). 보안정책 §4.9 는
 *   비교 불가능한 지표를 단일 순위로 만드는 것을 금지한다. 전략 §11.3 은 "그래도 비교를
 *   보여줘야 한다면 점수가 아니라 **같은 직군 내 지표 분포**로 가라"고 방향만 정해 두었다
 *   (표시 방식 자체는 §8 미결정이라 여기서 정하지 않는다).
 *
 * 그래서 이 모듈이 강제하는 것은 **한 줄의 규칙**이다:
 *   값을 비교하려면 `(cohort, metricCode, unit)` 가 완전히 같아야 한다. 하나라도 다르면
 *   비교 불가다 — 섞어서 순위를 내려는 호출은 조립 단계에서 예외로 터뜨린다.
 *
 * 왜 타입이 아니라 런타임 가드인가:
 *   `ComparableMetric[]` 배열에는 직군이 다른 두 지표도 문법적으로 멀쩡히 들어간다.
 *   급할 때 누군가 "전체 전문가 랭킹"을 만들려고 그 배열을 그대로 정렬한다. 그 순간
 *   차별점이 조용히 사라지므로, `search.ts` 와 똑같이 **배포 전에 드러나게** 던진다.
 *
 * 왜 cohort 를 호출부가 넘기는가:
 *   무엇이 "같은 직군"인지는 데이터(프로필의 specialties·파일럿 직군 enum)가 정하고 아직
 *   미정이다(전략 §11.1). 도메인은 그 정의를 내리지 않고 **동일성만** 본다 — I/O 금지 규칙과
 *   같은 이유로, 모집단을 어떻게 나눌지는 순수 함수가 결정할 몫이 아니다.
 */

/**
 * 비교 대상 한 건. `metric.ts` 의 `MetricClaimInput` 과 짝을 이루지만 **비교에 필요한 축만** 담는다.
 * 값의 유효성(기간·분모·근거)은 이미 `validateMetricClaim()` 이 봤다고 가정한다 — 여기 관심사는
 * "이 둘을 나란히 세워도 되는가" 하나뿐이다.
 */
export interface ComparableMetric {
  /** 집합 안에서 이 건을 가리키는 식별자. 결과를 되짚을 때 쓴다 (값은 도메인이 해석하지 않는다). */
  claimId: string;
  /** 비교 모집단(직군 등). 호출부가 정한다. 다르면 비교 불가 (§4.9). */
  cohort: string;
  /** 지표 코드. 다르면 비교 불가 — "성약 건수"와 "승소 건수"는 같은 축이 아니다. */
  metricCode: string;
  /** 단위. 같은 코드라도 단위가 다르면(건 vs 억원) 비교 불가. */
  unit: string;
  /** 비교할 수치. `metric.ts` 가 이미 유한수임을 보장했다고 가정하되, 여기서도 한 번 더 막는다. */
  value: number;
}

/** `(cohort, metricCode, unit)` 를 하나의 비교가능성 키로 접는다. 키가 같아야만 나란히 세울 수 있다. */
export type CohortKey = string;

/**
 * 비교가능성 키. 구분자는 **값에 나올 수 없는 문자**여야 충돌이 없다 —
 * cohort·code·unit 에 `\u0000` 가 들어오는 일은 없으므로 NUL 로 잇는다
 * (예: `"법무"` + `"cases_won"` + `"건"` 가 `"법무\u0000cases_won\u0000건"`).
 */
export function cohortKeyOf(m: Pick<ComparableMetric, "cohort" | "metricCode" | "unit">): CohortKey {
  return `${norm(m.cohort)}\u0000${norm(m.metricCode)}\u0000${norm(m.unit)}`;
}

/** 두 지표가 나란히 세워도 되는 사이인가. 키가 완전히 같을 때만 참이다. */
export function areComparable(
  a: Pick<ComparableMetric, "cohort" | "metricCode" | "unit">,
  b: Pick<ComparableMetric, "cohort" | "metricCode" | "unit">,
): boolean {
  return cohortKeyOf(a) === cohortKeyOf(b);
}

/**
 * P-071 의 핵심 관문. 집합이 **단 하나의 비교가능성 키**로만 이루어졌는지 확인하고,
 * 아니면 던진다. "비교 불가 지표를 단일 순위로 만들려는" 시도가 여기서 막힌다.
 *
 * 빈 집합은 통과시킨다 — 비교할 것이 없으면 규칙을 어길 수도 없다. 던지는 경우는
 * **섞인 집합을 하나처럼 다루려는** 때뿐이다.
 */
export function assertComparableSet(claims: readonly ComparableMetric[]): void {
  const keys = new Set<CohortKey>();
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    // noUncheckedIndexedAccess: 인덱싱 결과는 undefined 일 수 있다.
    if (!c) continue;
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
      throw new Error(`비교할 수 없는 값 (P-071): claimId=${c.claimId} value=${String(c.value)}`);
    }
    keys.add(cohortKeyOf(c));
  }
  if (keys.size > 1) {
    // 어떤 축들이 섞였는지 보여 준다 — 원인이 "직군이 다르다"인지 "단위가 다르다"인지 바로 보이게.
    throw new Error(
      `비교 불가 지표를 단일 순위로 만들 수 없다 (P-071 / 보안정책 §4.9): ${keys.size}개 모집단이 섞였다 [${[...keys]
        .map(readableKey)
        .join(" / ")}]`,
    );
  }
}

/**
 * 섞인 집합을 비교가능성 키별로 나눈다. 호출부가 **각 직군 안에서만** 다루도록 강제하는 안전한 길이다
 * — "전체를 한 줄로"를 막는 `assertComparableSet` 의 짝이다.
 *
 * 입력 순서를 그룹 안에서 보존한다(안정 분할). 응답 diff·스냅샷이 흔들리지 않게 하려는 것이고,
 * 이 순서가 우열을 뜻하지는 않는다(가중치·순서가 의미를 가지면 그게 곧 점수다 → N-3).
 */
export function groupByCohort(claims: readonly ComparableMetric[]): Map<CohortKey, ComparableMetric[]> {
  const out = new Map<CohortKey, ComparableMetric[]>();
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (!c) continue;
    const key = cohortKeyOf(c);
    const bucket = out.get(key);
    if (bucket) bucket.push(c);
    else out.set(key, [c]);
  }
  return out;
}

/** 같은 코호트 안에서의 **분포상 위치**. 점수가 아니라 "N명 중 몇 번째"라는 서수다. */
export interface DistributionPosition {
  claimId: string;
  cohort: string;
  metricCode: string;
  unit: string;
  /** 1-기반 순위. 값이 같으면 같은 순위를 공유한다(경쟁 순위법). 전역 점수가 아니다. */
  position: number;
  /** 이 코호트의 표본 수. `position` 은 `of` 없이는 뜻이 없다 — "3등"과 "3/4등"은 다르다. */
  of: number;
}

/**
 * 전략 §11.3 이 허락한 **유일한** 비교: 같은 직군·지표·단위 안에서의 분포상 위치.
 *
 * 입력이 하나의 코호트가 아니면 `assertComparableSet` 이 먼저 던진다 — 즉 이 함수는 설계상
 * **직군을 가로지르는 숫자를 절대 만들지 않는다.** 반환값은 서수(位)일 뿐 스칼라 점수가 없고,
 * 그래서 두 직군의 결과를 나란히 놓아도 "누가 더 위냐"로 합쳐지지 않는다(N-3).
 *
 * `higherIsBetter` 를 받는 이유: "성약 건수"는 클수록, "평균 응답시간"은 작을수록 앞이다.
 * 기본값을 두지 않고 호출부가 매번 명시하게 한다 — 방향을 잘못 잡은 분포는 거짓말이고,
 * 그 결정은 지표마다 다르므로 도메인이 임의로 고르면 안 된다.
 */
export function distributionWithinCohort(
  claims: readonly ComparableMetric[],
  opts: { higherIsBetter: boolean },
): DistributionPosition[] {
  assertComparableSet(claims);

  const present = claims.filter((c): c is ComparableMetric => Boolean(c));
  const of = present.length;
  if (of === 0) return [];

  // 큰 값이 앞서는지 작은 값이 앞서는지로 정렬 비교자를 고정한다. 안정성은 position 계산에서 값으로만 판단한다.
  const sorted = [...present].sort((a, b) => (opts.higherIsBetter ? b.value - a.value : a.value - b.value));

  const out: DistributionPosition[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (!c) continue;
    // 경쟁 순위법: 같은 값은 같은 순위를 공유하고, 그 다음 순위는 건너뛴다(1,1,3 …).
    // 서수를 "점수"로 오해하지 않게 — 동점이 있으면 1등이 여럿일 수 있다는 사실을 그대로 드러낸다.
    let position = i + 1;
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev && prev.value === c.value) {
        const last = out[out.length - 1];
        if (last) position = last.position;
      }
    }
    out.push({
      claimId: c.claimId,
      cohort: c.cohort,
      metricCode: c.metricCode,
      unit: c.unit,
      position,
      of,
    });
  }
  return out;
}

/** cohort·code·unit 정규화. 앞뒤 공백 차이로 같은 모집단이 둘로 갈리지 않게 한다. */
function norm(v: string): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 키를 사람이 읽을 수 있게 되돌린다 — 예외 메시지 전용(NUL 을 ·로 바꾼다). */
function readableKey(key: CohortKey): string {
  return key.split("\u0000").join("·");
}
