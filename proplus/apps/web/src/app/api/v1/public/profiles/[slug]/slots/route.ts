/**
 * P-120 가용 시간 · P-121 예약 요청(선행 조회) · P-123 취소 정책 표시 — 공개 슬롯 조회.
 *
 * `auth: false` 다. 예약은 비회원이 하는 행동이므로 슬롯도 로그인 없이 보여야 한다.
 *
 * ## rate limit 을 거는 이유 (P-189)
 *
 * 이 조회는 **한 요청이 최대 1000개 슬롯을 생성**한다(`MAX_SLOTS`, 날짜×규칙×슬롯 교차 생성).
 * 공개·무인증·계산량 많은 조합은 그대로 두면 증폭 공격 표면이다. 버킷은 공개 조회와 같은
 * `public.view` 를 쓴다 — 같은 방문자의 공개 경로 사용을 하나의 예산으로 묶는다.
 *
 * 날짜 기본값은 라우트가 채운다(모듈은 둘 다 필수로 받는다). `from` 이 해석되지 않는 문자열이면
 * 기본 `to` 를 계산하지 못하므로 **그대로 모듈에 넘겨** `invalid_date` 로 응답시킨다 —
 * 라우트에서 날짜 산술을 하다 `RangeError` 로 500 이 나가는 쪽이 더 나쁘다.
 */

import { booking, consumeLimit } from "@proplus/api";
import { route } from "@/lib/server";

/** 2주. 화면이 한 번에 보여주는 범위이고, 더 긴 범위는 `from`·`to` 를 명시해 받는다(모듈 상한 62일). */
const DEFAULT_RANGE_DAYS = 14;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const GET = route<{ slug: string }>(
  async ({ req, ctx, params }) => {
    await consumeLimit("public.view", ctx.ip);

    const sp = req.nextUrl.searchParams;
    const fromParam = sp.get("from")?.trim();
    const from = fromParam && fromParam !== "" ? fromParam : isoDate(new Date());

    const toParam = sp.get("to")?.trim();
    let to: string;
    if (toParam && toParam !== "") {
      to = toParam;
    } else {
      const base = Date.parse(`${from}T00:00:00Z`);
      to = Number.isNaN(base) ? from : isoDate(new Date(base + DEFAULT_RANGE_DAYS * 86_400_000));
    }

    // SlotList 를 그대로 싣는다: `period` 와 `cancellationPolicyVersion` 이 함께 가야
    // 화면이 "어느 기간의 슬롯이고 어떤 취소 정책인지"를 지어내지 않는다 (P-123).
    return booking.availableSlots(params.slug, from, to);
  },
  { auth: false },
);
