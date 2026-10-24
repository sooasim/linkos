/**
 * P-132/P-133 전환 퍼널 · P-135 기간별 요약 · P-141 요금제 보관 기간 (모듈명세 M09).
 *
 * ## 숫자만 보여주는 카드를 만들지 않는다
 *
 * M09 수용기준은 "집계 기준·기간을 명시"다. 그래서 응답의 `period` 와 `basis` 를 화면에 **그대로** 적고,
 * 각 카드에도 그 기간을 붙인다. 기준 없는 숫자는 해석이 불가능하고, 해석이 불가능한 숫자는
 * 결국 유리하게 해석된다 — N-8 이 측정 지표에 대해 막는 것과 같은 실패 모드다.
 *
 * `period.clampedByPlan` 을 숨기지 않는 이유: **요금제 때문에 잘린 기간**과 **데이터가 없는 기간**은
 * 다른 사실이다. 잘린 것을 말하지 않으면 사용자는 "조회가 줄었다"고 읽는다.
 *
 * ## 표본이 적을 때 전환율을 강조하지 않는다
 *
 * 분모가 한 자리 수인 비율은 한 사람이 들어오고 나가는 것으로 수십 퍼센트가 움직인다.
 * 그런 숫자를 크게 그리면 의사결정을 노이즈에 맡기게 되므로, 분모가 `MIN_SAMPLE` 건 미만이면
 * 비율을 쓰지 않고 그 사실을 적는다.
 *
 * 일별 추이(`metrics.byDay`)는 아직 그리지 않는다 — 차트를 넣으려면 클라이언트 JS 가 필요하고,
 * 지금 화면의 결론(단계별 건수·전환율)은 표로 충분하다. 데이터는 응답에 있으므로 나중에 붙일 수 있다.
 */

import { ApiError, analytics } from "@proplus/api";
import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/server";

export const metadata: Metadata = { title: "전환 분석" };

/** 라우트의 기본 조회 창(30일)과 같게 둔다. 프리셋만 허용해 날짜 파싱을 화면에서 하지 않는다. */
const WINDOW_PRESETS = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;

/** 비율을 쓰기 시작하는 최소 분모. 근거 있는 임계값이 문서에 없어서 "한 자리 수는 쓰지 않는다"로 둔다. */
const MIN_SAMPLE = 10;

function parseDays(raw: string | string[] | undefined): number {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return (WINDOW_PRESETS as readonly number[]).includes(v) ? v : DEFAULT_DAYS;
}

function day(iso: string): string {
  return iso.slice(0, 10).replaceAll("-", ".");
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const days = parseDays(sp.days);
  const { ctx } = await getViewer();

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  let summary: analytics.SummaryResult | null = null;
  let funnel: analytics.FunnelResult | null = null;
  let failure: { code: string; message: string } | null = null;
  try {
    // 같은 기간·같은 권한으로 두 집계를 함께 본다 (라우트의 `?include=funnel` 과 같은 조합).
    summary = await analytics.summary(ctx, from, to);
    funnel = await analytics.conversionFunnel(ctx, from, to);
  } catch (e) {
    failure =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "일시적인 오류가 발생했습니다." };
  }

  const periodText = summary ? `${day(summary.period.from)} ~ ${day(summary.period.to)}` : "";

  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <header>
        <p className="eyebrow">PROPLUS INSIGHTS</p>
        <h1 className="display mt-3 text-[32px] sm:text-[42px]">전환 분석</h1>
        <p className="lede mt-3 text-[15px]">
          프로필 조회부터 상담·예약까지 각 단계의 건수를 보여줍니다. 모든 숫자에는 집계 기간과 집계 기준이 함께 붙습니다.
        </p>
      </header>

      <nav className="mt-7 flex flex-wrap gap-2" aria-label="조회 기간">
        {WINDOW_PRESETS.map((d) => (
          <Link
            key={d}
            href={`/app/analytics?days=${d}`}
            aria-current={days === d ? "page" : undefined}
            className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${
              days === d
                ? "border border-solid border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "border border-solid border-[color:var(--line-strong)] text-[var(--fg-mute)]"
            }`}
          >
            최근 {d}일
          </Link>
        ))}
      </nav>

      {failure || !summary || !funnel ? (
        <div className="panel mt-8 p-6" role="alert">
          <p className="text-[15px] font-semibold">{failure?.message ?? "집계를 불러오지 못했습니다."}</p>
          <p className="mt-2 text-[13px] text-[var(--fg-mute)]">오류 코드: {failure?.code ?? "error"}</p>
          {failure?.code === "unauthorized" ? (
            <Link href="/login?next=/app/analytics" className="btn btn-ghost mt-5">
              로그인
            </Link>
          ) : failure?.code === "not_found" ? (
            <p className="mt-3 text-[13.5px]">먼저 프로필을 만들면 조회 통계가 쌓입니다.</p>
          ) : null}
        </div>
      ) : (
        <>
          {/* ── 기간·기준 (M09 수용기준) ─────────────────────── */}
          <section className="card mt-8 p-6" aria-labelledby="basis">
            <h2 id="basis" className="text-[17px] font-semibold">
              집계 기간과 기준
            </h2>
            <dl className="disclosure-dl mt-3">
              <dt>집계 기간</dt>
              <dd>{periodText}</dd>

              <dt>요청한 시작일</dt>
              <dd>{day(summary.period.requestedFrom)}</dd>

              <dt>요금제</dt>
              <dd>
                {summary.period.planCode} · 통계 보관 {summary.period.retentionDays}일
              </dd>

              <dt>집계 기준</dt>
              <dd>{summary.basis}</dd>

              <dt>퍼널 기준</dt>
              <dd>{funnel.basis}</dd>
            </dl>

            {summary.period.clampedByPlan ? (
              <p className="mt-4 text-[13.5px] font-semibold leading-relaxed text-[var(--pending)]" role="note">
                요금제의 통계 보관 기간({summary.period.retentionDays}일)보다 긴 기간을 요청해 시작일이{" "}
                {day(summary.period.from)}로 조정되었습니다. 이 구간 밖의 데이터가 없는 것이 아니라, 조회 범위가 잘린
                것입니다.
              </p>
            ) : null}
          </section>

          {/* ── 요약 카드 ───────────────────────────────────── */}
          <section className="mt-6" aria-labelledby="summary">
            <h2 id="summary" className="text-[17px] font-semibold">
              기간 내 건수
            </h2>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCard label="프로필 조회" value={summary.metrics.views} period={periodText} />
              <MetricCard
                label="고유 방문자"
                value={summary.metrics.uniqueVisitors}
                period={periodText}
                note="(IP+UA+salt) 해시 기준"
              />
              <MetricCard label="CTA 클릭" value={summary.metrics.ctaClicks} period={periodText} />
              <MetricCard label="상담 제출" value={summary.metrics.leadSubmits} period={periodText} />
              <MetricCard label="예약 완료" value={summary.metrics.appointmentsBooked} period={periodText} />
              <MetricCard label="배지 열람" value={summary.metrics.badgeViews} period={periodText} />
              <MetricCard label="상품 카드 열람" value={summary.metrics.offerViews} period={periodText} />
            </ul>
          </section>

          {/* ── 퍼널 ───────────────────────────────────────── */}
          <section className="mt-8" aria-labelledby="funnel">
            <h2 id="funnel" className="text-[17px] font-semibold">
              조회 → CTA 클릭 → 상담 → 예약
            </h2>
            <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
              같은 방문자의 반복 행동도 각각 셉니다. 분모가 {MIN_SAMPLE}건 미만인 단계는 비율을 표시하지 않습니다 —
              한두 건의 차이로 비율이 크게 흔들려 해석할 수 없기 때문입니다.
            </p>

            <div className="card mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-[14px]">
                <caption className="sr-only">
                  단계별 건수와 전환율. 집계 기간 {periodText}, 기준 {funnel.basis}
                </caption>
                <thead>
                  <tr className="border-b border-[var(--line)] text-[12.5px] text-[var(--fg-mute)]">
                    <th scope="col" className="px-4 py-3 font-semibold">
                      단계
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      건수 ({periodText})
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      직전 단계 대비
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      첫 단계 대비
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {funnel.stages.map((s, i) => {
                    const prev = i === 0 ? null : (funnel.stages[i - 1]?.count ?? null);
                    const top = funnel.stages[0]?.count ?? null;
                    return (
                      <tr key={s.stage} className="border-b border-[var(--line)] last:border-0">
                        <th scope="row" className="px-4 py-4 text-[14.5px] font-semibold">
                          {s.label}
                        </th>
                        <td className="px-4 py-4 text-[20px] font-semibold tabular-nums">{s.count.toLocaleString("ko-KR")}</td>
                        <td className="px-4 py-4 text-[13px] text-[var(--fg-mute)]">
                          {i === 0 ? "—" : <Rate rate={s.fromPrevious} denominator={prev} />}
                        </td>
                        <td className="px-4 py-4 text-[13px] text-[var(--fg-mute)]">
                          {i === 0 ? "—" : <Rate rate={s.fromTop} denominator={top} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 유입 경로 ──────────────────────────────────── */}
          <section className="mt-8" aria-labelledby="referrers">
            <h2 id="referrers" className="text-[17px] font-semibold">
              유입 경로 상위
            </h2>
            {summary.metrics.topReferrers.length === 0 ? (
              <p className="mt-3 text-[14px] text-[var(--fg-mute)]">기간 내 기록된 유입 경로가 없습니다.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {summary.metrics.topReferrers.map((r) => (
                  <li key={r.host} className="panel flex items-center justify-between gap-4 p-4 text-[14px]">
                    <span>{r.host}</span>
                    <span className="tabular-nums text-[var(--fg-mute)]">
                      {r.count.toLocaleString("ko-KR")}건 · {periodText}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[12.5px] text-[var(--fg-mute)]">
              유입 경로는 도메인(host)까지만 기록합니다. 전체 주소와 방문자 식별 정보는 저장하지 않습니다.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/** 숫자 하나만 있는 카드를 만들지 않는다 — 라벨 + 값 + **집계 기간**이 한 덩어리다 (M09). */
function MetricCard({
  label,
  value,
  period,
  note,
}: {
  label: string;
  value: number;
  period: string;
  note?: string;
}) {
  return (
    <li className="card flex flex-col gap-1 p-5">
      <span className="text-[13px] font-semibold text-[var(--fg-mute)]">{label}</span>
      <span className="text-[28px] font-semibold tabular-nums">{value.toLocaleString("ko-KR")}</span>
      <span className="text-[12px] text-[var(--fg-mute)]">
        {period}
        {note ? ` · ${note}` : ""}
      </span>
    </li>
  );
}

/**
 * 전환율 한 칸. 세 가지 경우를 **다른 문장**으로 말한다:
 *   분모 0 → 비율이 정의되지 않는다 / 분모가 작다 → 비율을 쓰지 않는다 / 그 외 → 비율과 분모를 함께 적는다.
 * 세 경우를 "0%" 하나로 합치면 "아무도 안 눌렀다"와 "아직 아무도 안 왔다"가 같은 화면이 된다.
 */
function Rate({ rate, denominator }: { rate: number | null; denominator: number | null }) {
  if (denominator === null || denominator === 0 || rate === null) return <span>분모 0건 · 비율 없음</span>;
  if (denominator < MIN_SAMPLE) {
    return (
      <span>
        표본 {denominator}건 · 비율 생략
        <span className="sr-only">표본이 적어 비율을 표시하지 않습니다.</span>
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {(rate * 100).toFixed(1)}% <span className="text-[12px]">(분모 {denominator.toLocaleString("ko-KR")}건)</span>
    </span>
  );
}
