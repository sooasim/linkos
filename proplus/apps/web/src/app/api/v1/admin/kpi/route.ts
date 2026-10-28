/**
 * 운영 KPI 요약 (06_개발로드맵 §3 · P-168 번복률 포함).
 *
 * 기간을 생략하면 최근 30일이다. 응답의 모든 블록이 자기 `period` 를 들고 오므로
 * 화면은 "기간 없는 숫자"를 그릴 수 없다 — N-8 이 측정 지표에 요구하는 것과 같은 규율을
 * 내부 지표에도 적용한다(기간·분모 없는 수치는 운영 판단을 잘못 이끈다).
 *
 * 날짜 검증은 모듈이 한다(`period_invalid` / `period_order_invalid`). 라우트가 같은 판정을
 * 다시 구현하면 두 벌이 되므로 `new Date()` 결과를 그대로 넘긴다.
 */

import { admin } from "@proplus/api";
import { route } from "@/lib/server";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  const rawTo = sp.get("to");
  const rawFrom = sp.get("from");
  const to = rawTo ? new Date(rawTo) : new Date();
  const from = rawFrom ? new Date(rawFrom) : new Date(to.getTime() - DEFAULT_WINDOW_MS);
  return admin.kpiSummary(ctx, from, to);
});
