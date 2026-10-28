/**
 * P-130 조회 기록 · P-131 CTA 클릭 · P-134 UTM 귀속 · P-136 배지 조회 — 분석 수집 비콘.
 *
 * `auth: false` 다. 공개 프로필 방문자는 비회원이 기본이고, 로그인한 사람만 세는 통계는 통계가 아니다.
 *
 * ## N-13 — 이 라우트는 IP·UA 를 **보지도, 적지도 않는다**
 *
 * `ctx.ip` 와 `ctx.userAgent` 를 모듈에 **원본으로 넘긴다**. 라우트에서 미리 해시하지 않는 이유는
 * 소금(`ANALYTICS_SALT`) 운용과 "소금이 없으면 해시를 아예 저장하지 않는다"는 판단이 M09 의 것이기
 * 때문이다(`analytics.ts` 주석). 모듈은 받은 즉시 `hashVisitor()` 결과만 INSERT 하고 원문은 버린다 —
 * 저장 전에 원문이 사라진다.
 *
 * 그 대신 이 파일이 지키는 것: **원문을 어디에도 남기지 않는다.** 로그를 찍지 않고(`log()` 호출 없음),
 * 응답 본문에 아무것도 담지 않고, 쿠키도 심지 않는다. 비콘에 추적 쿠키를 붙이면 "집계를 위해
 * 1st-party 식별자를 심는" 일이 공개 조회마다 일어난다 — 해시 기준 집계로 충분하다.
 *
 * ## 응답이 204 인 이유
 *
 * 1. 가볍다. 공개 프로필은 LCP 예산이 있는 핫패스다(P-194).
 * 2. **오라클을 만들지 않는다.** 모듈은 공개되지 않은 프로필의 사건을 `{recorded:false}` 로 조용히
 *    버리는데(N-4), 그 사실을 응답에 실으면 비콘이 "이 slug 가 공개 상태인가"를 묻는 도구가 된다.
 *    기록됐든 버려졌든 204 다.
 *
 * 클라이언트는 `content-type: application/json` 을 보내야 한다 — `route()` 래퍼가 폼 전송을 받지 않는다
 * (CSRF, 보안정책 §2). `navigator.sendBeacon(url, new Blob([json], {type:'application/json'}))` 형태.
 */

import { analytics, consumeLimit } from "@proplus/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * `kind` 를 zod enum 으로 묶지 않고 문자열로 받는다: 기록 가능한 사건의 **닫힌 집합**은
 * `analytics.ANALYTICS_KINDS` 이고 모듈이 `unknown_kind` 로 거부한다. 라우트에 같은 집합을 베껴 두면
 * 새 사건을 추가할 때 두 곳을 고쳐야 하고, 하나를 잊으면 400 의 원인이 둘로 갈라진다.
 *
 * `occurredAt` 은 **받지 않는다.** 클라이언트가 시각을 정할 수 있으면 과거·미래로 조작된 이벤트가
 * 기간별 요약(P-135)에 섞인다. 모듈은 생략 시 `now()` 를 쓴다.
 *
 * 다른 쓰기 본문과 달리 `strictObject` 를 **쓰지 않는다**: 이 비콘은 브라우저에 오래 캐시된 공개
 * 페이지에서 온다. 새 필드를 더한 뒤 구버전 페이지가 모르는 키를 보내 400 이 되면 통계가 조용히
 * 끊긴다. 모르는 키는 버리고 기록을 계속하는 쪽이 맞다 — 버려진 키가 사용자 데이터를 잃게 하지 않는다.
 */
const eventBody = z.object({
  kind: z.string().min(1).max(64),
  slug: z.string().max(64).nullable().optional(),
  profileId: z.uuid().nullable().optional(),
  /** 무엇이 눌렸는지(식별자·코드). 모듈이 sanitize + redact 를 한 번 더 거친다 (N-13). */
  target: z.string().max(300).nullable().optional(),
  /** 모듈이 **호스트만** 남기고 경로·쿼리를 버린다 — 라우트는 길이만 제한한다. */
  referrer: z.string().max(2048).nullable().optional(),
  utm: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const POST = route(
  async ({ ctx, body }) => {
    /**
     * P-189: 모듈도 `public.view` 한도를 걸지만 그것은 **프로필을 해석한 뒤**다. 라우트의 한도는
     * 그 조회 자체를 보호한다(해석 불가능한 slug 를 쏟아붓는 경우). 버킷 키가 서로 다르므로
     * (모듈은 방문자 해시, 여기는 ip) 같은 예산을 두 번 깎지 않는다.
     */
    await consumeLimit("public.view", ctx.ip);

    await analytics.track({
      ...parse(eventBody, body),
      // 원본을 넘기고 해시는 모듈이 한다 (위 N-13 설명).
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return new NextResponse(null, { status: 204 });
  },
  { auth: false },
);
