/**
 * P-172 운영 KPI (로드맵 §3 — 발행수·검증완료율·처리시간·만료예정·SLA·전환율).
 *
 * ## 모든 수치에 집계 범위를 붙인다
 *
 * N-8 은 공개 지표에 기간·분모·제외조건을 요구한다. 내부 운영 지표에도 같은 규율을 적용하는 이유는
 * 규칙 때문이 아니라 **기간을 모르는 숫자가 운영 판단을 잘못 이끌기** 때문이다. 그래서 이 화면의
 * 모든 카드는 `period`(기간 집계) 또는 `asOf`(시점 집계)를 함께 적는다. 모듈 반환이 블록마다
 * 자기 `period` 를 들고 오므로, 화면이 "기간 없는 숫자"를 그리려면 일부러 지워야 한다.
 *
 * ## 반환에 없는 지표는 그리지 않는다
 *
 * `admin.kpiSummary()` 의 `KpiSummary` 에 있는 값만 쓴다. 로드맵 §3 의 "SLA" 는 목표치가 아직
 * 미확정(전략 §8 / 로드맵 미결정 §2)이므로 **목표 대비 달성률을 만들지 않고** 실측 평균 처리시간만
 * 적는다 — 없는 기준선으로 계산한 달성률은 숫자 모양의 거짓이다.
 */

import { ApiError, admin } from "@proplus/api";
import { getViewer } from "@/lib/server";

/** 모듈이 네임스페이스로 내보내지므로(`export * as admin`) 타입도 네임스페이스로 집는다. */
type KpiSummary = admin.KpiSummary;

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 날짜·시각은 **UTC 로 고정 표기**한다. 서버 컴포넌트에서 보는 사람의 시간대로 그리면 SSR 결과가
 * 요청자마다 달라지고, "언제까지의 집계인가"가 사람마다 다른 날짜로 읽힌다 (Badge.tsx 와 같은 판단).
 * 시각까지 보여야 하는 운영 화면용 `fmtDateTime()` 은 "use client" 모듈이라 여기서 쓰지 않는다.
 */
function utcDay(iso: string): string {
  return iso.slice(0, 10).replaceAll("-", ".");
}

function utcMinute(iso: string): string {
  return `${utcDay(iso)} ${iso.slice(11, 16)} UTC`;
}

function inputDay(iso: string): string {
  return iso.slice(0, 10);
}

/** 0~1 비율을 백분율 문자열로. null 은 "분모가 없다"는 뜻이므로 0% 로 바꾸지 않는다. */
function pct(v: number | null): string | null {
  return v === null ? null : `${(v * 100).toFixed(1)}%`;
}

function hours(v: number | null): string | null {
  return v === null ? null : `${v}시간`;
}

interface StatProps {
  label: string;
  /** 포맷된 값. null 이면 "집계할 데이터가 없음"으로 그린다 — 0 과 구분해야 한다. */
  value: string | null;
  /** 이 수치의 집계 범위. 기간 집계면 기간, 시점 집계면 기준 시각. 비워 둘 수 없다. */
  scope: string;
  note?: string;
}

function Stat({ label, value, scope, note }: StatProps) {
  return (
    <div className="card flex flex-col gap-1.5 p-5">
      <p className="text-[13px] font-semibold text-[var(--fg-mute)]">{label}</p>
      <p className="text-[28px] font-semibold leading-none tracking-tight">
        {value ?? <span className="text-[18px] font-normal text-[var(--fg-mute)]">집계할 데이터 없음</span>}
      </p>
      <p className="mt-auto pt-1 text-[12px] leading-relaxed text-[var(--fg-mute)]">{scope}</p>
      {note ? <p className="text-[12px] leading-relaxed text-[var(--fg-mute)]">{note}</p> : null}
    </div>
  );
}

function periodLabel(p: KpiSummary["period"]): string {
  return `집계 기간 ${utcDay(p.from)} – ${utcDay(p.to)}`;
}

export default async function AdminKpiPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { ctx } = await getViewer();

  // `type="date"` 는 YYYY-MM-DD 만 준다. UTC 자정으로 고정해야 같은 입력이 항상 같은 기간을 뜻한다.
  const to = sp.to ? new Date(`${sp.to}T00:00:00Z`) : new Date();
  const from = sp.from ? new Date(`${sp.from}T00:00:00Z`) : new Date(to.getTime() - DEFAULT_WINDOW_MS);

  let kpi: KpiSummary | null = null;
  let error: string | null = null;
  try {
    kpi = await admin.kpiSummary(ctx, from, to);
  } catch (e) {
    // 기간 검증은 모듈이 한다(`period_invalid` / `period_order_invalid`). UI 는 그 메시지를 보여주는 일만 한다.
    if (!(e instanceof ApiError)) throw e;
    error = e.message;
  }

  const fromDay = Number.isNaN(from.getTime()) ? (sp.from ?? "") : inputDay(from.toISOString());
  const toDay = Number.isNaN(to.getTime()) ? (sp.to ?? "") : inputDay(to.toISOString());

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="eyebrow">P-172 · 운영 KPI</p>
        <h1 className="display mt-3 text-[32px] sm:text-[40px]">운영 지표</h1>
        <p className="lede mt-3 text-[15px]">
          각 수치에 집계 기간 또는 기준 시각을 함께 적습니다. 기간 없는 숫자는 판단 근거가 되지 못합니다.
        </p>
      </div>

      {/* JS 없이 동작하는 GET 폼. 인라인 스크립트는 CSP 가 막고(P-042), 기간 선택에 JS 가 필요하지도 않다. */}
      <form method="get" action="/admin" className="panel flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-[150px]">
          <label className="label" htmlFor="kpi-from">
            시작 (UTC)
          </label>
          <input id="kpi-from" name="from" type="date" className="field" defaultValue={fromDay} />
        </div>
        <div className="min-w-[150px]">
          <label className="label" htmlFor="kpi-to">
            종료 (UTC)
          </label>
          <input id="kpi-to" name="to" type="date" className="field" defaultValue={toDay} />
        </div>
        <button type="submit" className="btn btn-ghost">
          기간 적용
        </button>
        <p className="w-full text-[12.5px] text-[var(--fg-mute)]">
          기간을 비우면 최근 30일입니다. 종료일은 포함하지 않습니다(시작 ≤ 집계 &lt; 종료).
        </p>
      </form>

      {error ? (
        <p role="alert" className="card border-[var(--caution)] p-5 text-[14.5px] text-[var(--caution)]">
          지표를 불러오지 못했습니다 — {error}
        </p>
      ) : null}

      {kpi ? (
        <>
          <section aria-labelledby="kpi-evidence" className="flex flex-col gap-4">
            <h2 id="kpi-evidence" className="text-[19px] font-semibold">
              검증 처리
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="제출된 증거" value={`${kpi.evidence.submitted}건`} scope={periodLabel(kpi.evidence.period)} />
              <Stat
                label="판정 완료율"
                value={pct(kpi.evidence.decisionRate)}
                scope={periodLabel(kpi.evidence.period)}
                note={`분모 = 기간 내 제출 ${kpi.evidence.submitted}건, 분자 = 승인·반려까지 간 건수`}
              />
              <Stat
                label="평균 판정 소요시간"
                value={hours(kpi.evidence.avgDecisionHours)}
                scope={periodLabel(kpi.evidence.period)}
                note="제출 시각부터 첫 승인·반려까지. 목표 SLA 는 아직 확정되지 않았습니다."
              />
              <Stat label="승인" value={`${kpi.evidence.verified}건`} scope={periodLabel(kpi.evidence.period)} />
              <Stat label="반려" value={`${kpi.evidence.rejected}건`} scope={periodLabel(kpi.evidence.period)} />
              <Stat
                label="미판정"
                value={`${kpi.evidence.pending}건`}
                scope={periodLabel(kpi.evidence.period)}
                note="대기·검토중·추가정보 필요"
              />
            </div>
          </section>

          <section aria-labelledby="kpi-badges" className="flex flex-col gap-4">
            <h2 id="kpi-badges" className="text-[19px] font-semibold">
              배지 현황
            </h2>
            <p className="text-[13.5px] text-[var(--fg-mute)]">
              기간 집계가 아니라 <strong className="font-semibold">시점 집계</strong>입니다. 기준 시각{" "}
              {utcMinute(kpi.badges.asOf)}.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="유효 배지" value={`${kpi.badges.active}개`} scope={`기준 ${utcMinute(kpi.badges.asOf)}`} />
              <Stat
                label="30일 내 만료 예정"
                value={`${kpi.badges.expiringSoon30d}개`}
                scope={`기준 ${utcMinute(kpi.badges.asOf)}`}
              />
              <Stat
                label="만료일이 지난 active 행"
                value={`${kpi.badges.pastExpiry}개`}
                scope={`기준 ${utcMinute(kpi.badges.asOf)}`}
                note="공개 화면에서는 읽기 시점 판정으로 이미 내려가 있습니다. 저장 상태와의 간격을 보여 주는 수치입니다."
              />
              <Stat label="취소" value={`${kpi.badges.revoked}개`} scope={`기준 ${utcMinute(kpi.badges.asOf)}`} />
              <Stat
                label="재확인 중"
                value={`${kpi.badges.disputed}개`}
                scope={`기준 ${utcMinute(kpi.badges.asOf)}`}
                note="공개 라벨은 “확인 필요”로 표시됩니다."
              />
            </div>
          </section>

          <section aria-labelledby="kpi-appeals" className="flex flex-col gap-4">
            <h2 id="kpi-appeals" className="text-[19px] font-semibold">
              이의제기
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="접수" value={`${kpi.appeals.created}건`} scope={periodLabel(kpi.appeals.period)} />
              <Stat
                label="미처리"
                value={`${kpi.appeals.open}건`}
                scope={periodLabel(kpi.appeals.period)}
                note="기간 내 접수분 중 아직 열린 건"
              />
              <Stat
                label="평균 처리시간"
                value={hours(kpi.appeals.avgResolutionHours)}
                scope={periodLabel(kpi.appeals.period)}
                note="접수부터 처리까지. 목표 SLA 는 아직 확정되지 않았습니다."
              />
              <Stat label="원 결정 유지" value={`${kpi.appeals.upheld}건`} scope={periodLabel(kpi.appeals.period)} />
              <Stat label="번복" value={`${kpi.appeals.overturned}건`} scope={periodLabel(kpi.appeals.period)} />
              <Stat
                label="번복률"
                value={pct(kpi.appeals.overturnRate)}
                scope={periodLabel(kpi.appeals.period)}
                note={`분모 = 유지 ${kpi.appeals.upheld} + 번복 ${kpi.appeals.overturned}`}
              />
            </div>
          </section>

          <section aria-labelledby="kpi-reports" className="flex flex-col gap-4">
            <h2 id="kpi-reports" className="text-[19px] font-semibold">
              신고
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="접수" value={`${kpi.reports.created}건`} scope={periodLabel(kpi.reports.period)} />
              <Stat
                label="미처리"
                value={`${kpi.reports.open}건`}
                scope={periodLabel(kpi.reports.period)}
                note="접수·검토중"
              />
              <Stat
                label="평균 처리시간"
                value={hours(kpi.reports.avgHandlingHours)}
                scope={periodLabel(kpi.reports.period)}
              />
              <Stat label="조치" value={`${kpi.reports.actioned}건`} scope={periodLabel(kpi.reports.period)} />
              <Stat label="기각" value={`${kpi.reports.dismissed}건`} scope={periodLabel(kpi.reports.period)} />
            </div>
          </section>

          <section aria-labelledby="kpi-conversion" className="flex flex-col gap-4">
            <h2 id="kpi-conversion" className="text-[19px] font-semibold">
              프로필과 전환
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat
                label="발행된 프로필 (누적)"
                value={`${kpi.profiles.publishedTotal}개`}
                scope="기간과 무관한 누적 집계"
              />
              <Stat
                label="기간 내 발행"
                value={`${kpi.profiles.publishedInPeriod}개`}
                scope={periodLabel(kpi.profiles.period)}
              />
              <Stat label="프로필 조회" value={`${kpi.conversion.profileViews}회`} scope={periodLabel(kpi.conversion.period)} />
              <Stat label="상담 요청" value={`${kpi.conversion.leads}건`} scope={periodLabel(kpi.conversion.period)} />
              <Stat
                label="조회 → 상담 전환율"
                value={pct(kpi.conversion.viewToLeadRate)}
                scope={periodLabel(kpi.conversion.period)}
                note={`분모 = 조회 ${kpi.conversion.profileViews}회, 분자 = 상담 요청 ${kpi.conversion.leads}건`}
              />
            </div>
            {/*
              모듈이 조회 이벤트를 `kind LIKE '%view%'` 로 세고 있다(admin.ts TODO(M09)).
              분류가 확정되기 전의 근사치라는 사실을 숨기면, 전환율이 왜 흔들리는지 아무도 모르게 된다.
            */}
            <p className="text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
              조회 수는 분석 이벤트 분류가 확정되기 전의 잠정 집계입니다(이벤트 종류 이름에 “view”가 포함된 건을 셉니다).
              분류가 정해지면 수치가 바뀔 수 있습니다.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
