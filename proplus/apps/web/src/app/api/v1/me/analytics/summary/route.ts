/**
 * P-135 기간별 요약 · P-132/P-133 상담·예약 전환 · P-141 요금제 보관 기간 —
 * 데이터모델 §4 (`GET /me/analytics/summary?from=&to=`).
 *
 * ## 응답을 깎지 않는다
 *
 * 모듈은 수치만 돌려주지 않고 `{ period, basis, metrics }` 를 함께 돌려준다 — 집계 기준·기간 없이
 * 숫자만 보여주는 것을 금지하는 N-8 과 같은 정신이다(M09 수용기준). 라우트가 `metrics` 만 꺼내
 * 싣고 싶은 유혹이 생기지만, 그러면 화면이 "무엇을 어떻게 센 숫자인지"를 지어내게 된다.
 * `period.clampedByPlan` 도 그대로 간다: 요금제 때문에 잘린 것과 데이터가 없는 것은 다른 사실이다.
 *
 * ## `?include=funnel`
 *
 * 데이터모델 §4 는 분석 경로를 `summary` 하나만 둔다. 전환 퍼널(P-132/P-133)은 모듈에 구현되어
 * 있는데 전용 경로가 없어서, 별도 경로를 발명하는 대신 **같은 기간·같은 권한**으로 선택 조회하게
 * 했다. 기본값은 끔이다 — 요약만 필요한 화면이 퍼널 쿼리 비용을 내지 않아야 한다.
 */

import { analytics } from "@proplus/api";
import { route } from "@/lib/server";

/** 기본 조회 창. 요금제의 `analyticsDays` 가 더 짧으면 모듈이 다시 잘라낸다 (P-141). */
const DEFAULT_WINDOW_DAYS = 30;

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const now = Date.now();

  // 날짜 **파싱은 모듈이 한다**(`invalid_date`·`invalid_period`). 라우트는 값이 없을 때만 기본값을 만든다 —
  // 사용자 입력으로 산술을 하지 않으므로 여기서 RangeError 가 날 수 없다.
  const to = sp.get("to")?.trim() || new Date(now).toISOString();
  const from = sp.get("from")?.trim() || new Date(now - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();

  const result = await analytics.summary(ctx, from, to);
  if (sp.get("include") !== "funnel") return result;

  return { ...result, funnel: await analytics.conversionFunnel(ctx, from, to) };
});
