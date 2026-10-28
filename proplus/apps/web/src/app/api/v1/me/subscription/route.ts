/**
 * P-141 한도 적용 · P-142 구독 상태 · P-143 해지 후 데이터 접근 — 내 구독.
 *
 * ## GET 이 두 가지를 함께 돌려주는 이유
 *
 * `subscription` 은 "무엇을 결제 중인가"이고 `plan` 은 "지금 실제로 적용되는 한도"다. 둘은 같지 않다:
 * 구독이 없으면 `subscription: null` 이지만 `plan` 은 free 한도이고, `past_due` 는 유료 한도를
 * 유지한다(유예, `billing.ts` 주석). 화면이 한도를 구독 상태에서 **추론**하면 그 추론이 모듈의
 * 분기와 어긋나는 순간 사용자에게 거짓말을 한다. `plan.source` 가 한도의 출처를 말해 준다.
 *
 * ## PUT 은 관리자 경로다
 *
 * 결제(PG)가 없는 상태에서 누구나 자기 요금제를 올릴 수 있으면 한도가 장식이 된다. 모듈이
 * `can(p,'admin.access')` 로 막는다 — 라우트는 그 판단을 복제하지 않고 모양만 검증한다.
 * **대상 사용자를 지정할 수 없다**: 모듈 시그니처에 대상 인자가 없어 호출자 자신의 구독을 바꾼다.
 * 그래서 경로도 `/me/subscription` 이다. TODO(P-144): 결제 요건 확정 시 `billing.manage` 능력과
 * 대상 인자가 추가되면 관리자 경로(`/admin/...`)로 옮긴다.
 */

import { billing } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const subscriptionBody = z.strictObject({
  planCode: z.string().min(1).max(64),
  status: z.enum(billing.SUBSCRIPTION_STATUSES).optional(),
});

export const GET = route(async ({ ctx }) => ({
  subscription: await billing.mySubscription(ctx),
  plan: await billing.planLimitsFor(ctx),
}));

export const PUT = route(async ({ ctx, body }) => {
  const { planCode, status } = parse(subscriptionBody, body);
  return { subscription: await billing.setSubscription(ctx, planCode, status) };
});

/**
 * P-143: 해지. 응답에 `afterCancel`(POST_CANCEL_POLICY)이 그대로 실린다 — 공개는 중단되지만
 * 워크스페이스는 읽기로 열리고 내보내기는 가능하며 **배지는 영향받지 않는다**(N-2). 화면이 이
 * 문구를 지어내지 않고 모듈이 준 정책을 그린다. `exportWindowDays: null` 은 "무기한"이 아니라
 * "법률검토 전(미결정 §2)"이고, 그 구분도 응답에 남아 있어야 한다.
 */
export const DELETE = route(async ({ ctx }) => billing.cancel(ctx));
