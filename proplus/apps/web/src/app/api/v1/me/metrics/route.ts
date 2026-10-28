/**
 * P-066 / P-067 측정 지표 (N-8: 기간·분모·표본수·산정근거 없이는 저장되지 않는다).
 *
 * 라우트가 `periodStart`·`periodEnd`·`sampleSize`·`basis` 를 **필수**로 받는 것이 N-8 의 첫 겹이다
 * (둘째는 도메인 `validateMetricClaim`, 셋째는 DB NOT NULL, 넷째는 `public_metric_view`).
 * 날짜는 `date` 컬럼이므로 `YYYY-MM-DD` 만 받는다 — 타임존이 섞인 값이 들어오면
 * "2026-06-30 기준"이 지역에 따라 하루 어긋난 숫자가 된다.
 *
 * 지표는 **내 프로필에만** 붙는다. `profileId` 를 입력으로 받지 않으므로 바꿔치기할 대상이 없다(N-12).
 * 응답에는 수치와 함께 공시 문구(`disclosure`)가 들어온다 — 화면은 둘을 **같이** 그려야 한다.
 */

import { proof } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({
  metricCode: z.string().min(1).max(60),
  // zod 4 의 z.number() 는 NaN·Infinity 를 기본적으로 거부한다 — 비유한수는 수치 공시에 쓸 수 없다.
  value: z.number(),
  unit: z.string().min(1).max(20),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  sampleSize: z.number().int().positive(),
  basis: z.string().min(1).max(500),
  /** P-067: 붙이려면 그 검증이 `system_integrated` + `verified` 여야 한다. 판정은 모듈과 DB 트리거가 한다. */
  verificationId: z.uuid().nullish(),
});

export const GET = route(async ({ ctx }) => ({ items: await proof.listMetricClaims(ctx) }));

export const POST = route(async ({ ctx, body }) => proof.addMetricClaim(ctx, parse(Body, body)), { status: 201 });
