/**
 * P-066 측정 지표 공개 표기 · P-068 응답시간 지표 · N-8 (보안정책 §4.8 / 브랜드 §5).
 *
 * 이 컴포넌트가 하는 일은 포맷팅이 아니라 **분리를 막는 것**이다.
 * "누적 128건" 처럼 숫자만 큰 글씨로 올리고 기간·표본·집계기준을 각주로 숨기면 N-8 은 DB 제약만
 * 남고 화면에서는 깨진다. 그래서 수치와 네 가지 조건을 **같은 카드 안에서** 그리고,
 * 조건이 하나라도 비면 수치를 아예 그리지 않는다.
 *
 * `public_metric_view` 가 이미 `basis <> '' AND sample_size > 0` 을 걸렀지만(0001_proplus_core.sql §M04)
 * 렌더러가 마지막 방어선이다 — 지표를 만드는 경로가 늘어나도 "조건 없는 숫자"는 여기서 멈춘다.
 *
 * N-1 / 기획서 §5-4: `verified: false` 는 **자기기재**다. 확인된 수치와 같은 모양으로 그리지 않는다.
 * N-3: 지표를 합산·점수화하지 않는다. 카드는 한 건씩 독립이고 순위 표기가 없다.
 */

import type { profile } from "@proplus/api";
import { formatBadgeDay } from "./Badge";

/**
 * 지표 코드 → 사람이 읽을 이름.
 *
 * `metric_claims.metric_code` 는 참조 테이블이 없는 자유 텍스트다(domain/metric.ts 주석:
 * "코드는 `evidence_types` 와 느슨하게 짝을 이룬다"). 그래서 **모르는 코드는 코드 그대로** 보여준다 —
 * 그럴듯한 한글 이름을 지어내면 화면이 DB 에 없는 사실을 말하게 된다.
 */
const METRIC_LABEL_KO: Readonly<Record<string, string>> = {
  contracts_closed: "계약 체결 건수",
  transaction_count: "거래 건수",
  transaction_volume: "거래 규모",
  response_time: "평균 응답 시간",
  aftercare_activity: "사후 관리 활동",
};

export function metricLabel(code: string): string {
  return METRIC_LABEL_KO[code] ?? code;
}

/** 서버에서만 그려지므로 로케일을 고정해도 하이드레이션 불일치가 없다(공개 프로필은 JS 없이 완결된다). */
const KO_NUMBER = new Intl.NumberFormat("ko-KR");

interface MetricClaimProps {
  metric: profile.PublicMetric;
}

export function MetricClaim({ metric }: MetricClaimProps) {
  // N-8: 기간·표본·집계기준이 없으면 "표시 불가"다. 숫자만 남기는 선택지는 없다.
  if (!metric.periodStart || !metric.periodEnd) return null;
  if (!Number.isFinite(metric.sampleSize) || metric.sampleSize <= 0) return null;
  if (metric.basis.trim().length === 0) return null;

  return (
    <li className="panel flex flex-col gap-2 p-5" data-testid="metric-claim" data-metric-code={metric.metricCode}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--fg-mute)]">{metricLabel(metric.metricCode)}</h3>
        {/*
          실제 배지가 아니므로 `.badge` 를 쓰지 않는다 — 지표에 배지 모양을 입히면 "확인된 배지"와
          "확인 근거가 붙은 수치"가 같은 것으로 읽힌다(랜딩의 설명용 칩과 같은 이유).
          색 대신 **테두리 선 모양 + 텍스트**로 구분한다(브랜드 §7: 색만으로 상태를 말하지 않는다).
        */}
        <span className={`chip ${metric.verified ? "" : "border-dashed"}`}>
          {metric.verified ? "확인 근거 있음" : "자기기재"}
        </span>
      </div>

      <p className="display text-[32px] leading-none">
        {KO_NUMBER.format(metric.value)}
        <span className="ml-1 align-baseline text-[16px] font-sans">{metric.unit}</span>
      </p>

      {/* 수치 바로 아래에 조건을 붙인다. 접었다 펴는 UI 로 만들지 않는 이유가 N-8 그 자체다. */}
      <dl className="disclosure-dl !mt-1 text-[12.5px]">
        <dt>측정 기간</dt>
        <dd>
          {formatBadgeDay(metric.periodStart)} ~ {formatBadgeDay(metric.periodEnd)}
        </dd>

        <dt>표본</dt>
        <dd>{KO_NUMBER.format(metric.sampleSize)}건</dd>

        <dt>집계 기준</dt>
        {/* N-10: 사용자 입력은 HTML 로 그리지 않는다. 줄바꿈만 살린다. */}
        <dd className="whitespace-pre-line">{metric.basis}</dd>
      </dl>

      <p className="text-[12px] leading-relaxed text-[var(--fg-mute)]">
        {metric.verified
          ? "확인된 근거가 있는 수치입니다. 위에 적힌 기간과 표본 안에서만 유효하며, 앞으로의 결과를 보장하지 않습니다."
          : "본인이 직접 적은 수치입니다. 확인 절차를 거치지 않았습니다."}
      </p>
    </li>
  );
}
