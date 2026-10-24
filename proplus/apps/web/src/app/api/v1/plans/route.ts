/**
 * P-140 요금제 정의 — 공개 요금제 목록.
 *
 * `auth: false` 다. 가격·한도 페이지는 가입 전에 보는 화면이다.
 *
 * 응답에 **가격이 없는 것이 정상이다**: `plans` 레코드는 `code`·`name`·`limits` 뿐이고, 가격은
 * 시장검증 전이라 확정되지 않았다(기획서 §9 / 미결정 §2). 라우트가 빈 자리를 임의 금액으로
 * 채우지 않는다.
 *
 * N-2 의 흔적도 여기서 보인다: `limits` 에 배지·검증 관련 키가 하나도 없다. 요금제가 노출 공간
 * (상품 카드 수·블록 수·분석 보관일·예약 기능)만 조절한다는 사실이 응답 그 자체로 드러나야 한다.
 */

import { billing } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route(async () => ({ plans: await billing.listPlans() }), { auth: false });
