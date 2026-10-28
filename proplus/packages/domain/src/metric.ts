/**
 * 측정 지표 정책 — N-8 (보안정책 §4.8 / 브랜드 §5).
 *
 * P-066 측정 지표 등록 · P-067 거래 수치는 연동 증거만 · P-068 응답시간 지표 표기
 *
 * 왜 이 모듈이 필요한가:
 *   "누적 643건", "평균 응답 12분" 같은 숫자는 기간과 분모가 없으면 아무 뜻이 없고,
 *   그런데도 가장 잘 팔리는 문구다. 보안정책 §4.8 은 측정 지표를 기간·분모·제외조건 없이
 *   표시하지 못하게 하라고 요구한다. DB 는 `metric_claims` 의
 *   `period_start/period_end/sample_size/basis` 를 NOT NULL 로 막고(0001_proplus_core.sql §M04),
 *   이 모듈은 **그 앞단에서 같은 것을 거부**한다 — 빈 문자열 basis 나 표본 0 은 NOT NULL 을 통과하므로
 *   DB 제약만으로는 부족하다. (`public_metric_view` 도 `basis <> '' AND sample_size > 0` 로 한 번 더 거른다.)
 */

import { isAtLeast, type VerificationMethod } from "./types";

export interface MetricClaimInput {
  metricCode: string;
  value: number;
  unit: string;
  /** 'YYYY-MM-DD' (DB `date` 컬럼과 같은 형식) */
  periodStart: string;
  periodEnd: string;
  /** 분모. 0 은 "측정하지 않았다"와 같아서 공개 대상이 아니다. */
  sampleSize: number;
  /** 집계 기준·제외 조건 설명. 이게 비면 수치의 의미가 재현되지 않는다. */
  basis: string;
  /** 이 수치를 뒷받침하는 검증의 강도. 없으면 자기기재다. */
  method?: VerificationMethod | null;
}

export type MetricResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * 'YYYY-MM-DD' **전체**를 엄격히 받는다. 로컬 시간대 해석으로 날짜가 하루 밀리는 것을 막기 위해
 * 느슨한 파싱은 쓰지 않는다.
 *
 * `$` 앵커가 필요한 이유: 앵커가 없으면 `"2026-01-01T12:00Z"` 나 `"2026-01-01abc"` 가 통과해
 * 조용히 `2026-01-01` 로 정규화된다. 지표의 측정 기간은 공개 화면에 그대로 찍히는 값이므로
 * (N-8 / 보안정책 §4.8), 호출부가 보낸 것과 저장된 것이 다르면 안 된다.
 * 시각이 붙은 값을 받고 싶으면 호출부가 날짜로 잘라서 보내게 하는 쪽이 명확하다.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validateMetricClaim(i: MetricClaimInput): MetricResult {
  if (!nonEmpty(i.metricCode)) {
    return { ok: false, code: "metric_code_required", message: "지표 코드가 필요합니다." };
  }
  // 단위 없는 수치는 "643"이 건수인지 억원인지 알 수 없다 — N-8 이 막으려는 것과 같은 종류의 문제다.
  if (!nonEmpty(i.unit)) {
    return { ok: false, code: "unit_required", message: "단위가 필요합니다." };
  }
  if (typeof i.value !== "number" || !Number.isFinite(i.value)) {
    return { ok: false, code: "value_invalid", message: "지표 값이 올바르지 않습니다." };
  }
  if (!Number.isFinite(i.sampleSize) || i.sampleSize <= 0) {
    return { ok: false, code: "sample_size_required", message: "표본 수가 1 이상이어야 합니다." };
  }
  if (!nonEmpty(i.basis)) {
    return { ok: false, code: "basis_required", message: "산정 근거(집계 기준·제외 조건)가 필요합니다." };
  }

  const start = toIsoDate(i.periodStart);
  const end = toIsoDate(i.periodEnd);
  if (!start || !end) {
    return { ok: false, code: "period_invalid", message: "측정 기간의 날짜 형식이 올바르지 않습니다." };
  }
  // ISO 날짜는 문자열 비교가 곧 시간 비교다. DB 의 CHECK (period_end >= period_start) 와 같은 조건.
  if (end < start) {
    return { ok: false, code: "period_order_invalid", message: "측정 종료일이 시작일보다 앞설 수 없습니다." };
  }

  // P-067: 조작 유인이 큰 지표는 시스템 연동 증거가 없으면 **검증된 수치로 등록할 수 없다.**
  // 여기서 한 번 막는 이유는 이중화다 — 지금까지 이 규칙은 DB 트리거
  // (`metric_claims_require_integration`) 한 겹으로만 서 있었고, 트리거는
  // `verification_id` 가 붙은 경우만 본다. 강도가 약한 검증을 들고 와서 "검증된 거래 실적"으로
  // 등록하려는 시도는 도메인에서 먼저 거부되는 편이 원인이 분명하다.
  const required = METRIC_REQUIRED_METHOD[i.metricCode];
  if (required && i.method != null && !isAtLeast(i.method, required)) {
    return {
      ok: false,
      code: "metric_requires_integration",
      message: "이 지표는 시스템 연동 데이터로만 검증할 수 있습니다.",
    };
  }

  return { ok: true };
}

/**
 * 지표 코드별 최소 검증 강도 (기획서 §7 / 보안정책 §4.8).
 *
 * 여기 없는 코드는 자기기재로 등록될 수 있고, 공개 화면에서 "자기기재"로 표기된다.
 * 코드는 `evidence_types` 와 느슨하게 짝을 이룬다 — DB 의 유형 테이블이 늘어날 수 있으므로
 * (P-050: 유형은 참조 테이블) 여기도 코드 enum 이 아니라 매핑 객체로 둔다.
 */
export const METRIC_REQUIRED_METHOD: Readonly<Record<string, VerificationMethod | undefined>> = {
  // 거래 실적·응답시간·사후관리는 집계값이라 "서류 한 장"으로 확인되지 않는다.
  contracts_closed: "system_integrated",
  transaction_count: "system_integrated",
  transaction_volume: "system_integrated",
  response_time: "system_integrated",
  aftercare_activity: "system_integrated",
};

/**
 * P-067 (기획서 §7): 거래 수치처럼 조작 유인이 큰 지표는 **시스템 연동 데이터만** 검증으로 인정한다.
 *
 * `document_reviewed`·`issuer_confirmed` 는 서류·발급기관 확인이라 "그 시점의 한 장"을 본 것이고,
 * 누적 거래량 같은 집계는 그 방식으로 확인되지 않는다. 그래서 여기만 다른 기준을 쓴다 —
 * 배지 일반 규칙(`badge.ts`)보다 좁다.
 */
export function isVerifiableMetric(method: VerificationMethod | null | undefined): boolean {
  return method === "system_integrated";
}

/**
 * 공개 화면에 수치와 **반드시 함께** 붙는 문구.
 *
 * 이 함수가 존재하는 이유는 포맷팅이 아니라 **분리를 막기 위함**이다. 렌더러가 값만 꺼내
 * "643건"을 그리는 대신 이 문자열을 함께 그리게 한다. 기간·분모·근거 중 하나라도 비면
 * `validateMetricClaim()` 이 이미 저장을 막았으므로 여기서는 세 가지가 모두 있다고 가정한다.
 *
 * 예: "2026-01-01~2026-06-30 · 표본 128건 · 집계기준: 사내 CRM 성약 기준, 취소 건 제외"
 */
export function formatMetricDisclosure(i: MetricClaimInput): string {
  const start = toIsoDate(i.periodStart) ?? i.periodStart;
  const end = toIsoDate(i.periodEnd) ?? i.periodEnd;
  return `${start}~${end} · 표본 ${i.sampleSize}건 · 집계기준: ${i.basis}`;
}

/** 엄격한 'YYYY-MM-DD' 정규화. 달력상 존재하지 않는 날(2026-02-30)도 거른다. */
function toIsoDate(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const m = ISO_DATE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(t)) return null;
  const back = new Date(t);
  // 정규화 결과가 입력과 다르면 2026-02-30 처럼 롤오버된 날짜다.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
  return `${pad4(y)}-${pad2(mo)}-${pad2(d)}`;
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
