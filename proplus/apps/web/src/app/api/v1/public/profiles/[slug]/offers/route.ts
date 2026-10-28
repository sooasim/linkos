/**
 * P-092 품절·만료 비공개 · P-093 외부 링크형 상품 — 데이터모델 §4 (`GET /public/profiles/{slug}/offers`).
 *
 * `auth: false` 다. 공개 미니사이트는 로그인 벽 없이 떠야 하고(브랜드 §6), 이 경로가 인증을 요구하면
 * 공개 프로필의 상품 섹션이 비어 보인다.
 *
 * 응답을 **재조립하지 않는다.** 모듈이 `public_offer_view` → `pickPublic(..., PUBLIC_OFFER_FIELDS)` 로
 * 두 번 걸러서 돌려준 DTO 를 그대로 싣는다 (N-4). 라우트가 필드를 더하거나 다른 조회를 섞으면
 * allowlist 를 우회하는 길이 생긴다.
 */

import { catalog } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route<{ slug: string }>(async ({ params }) => ({ offers: await catalog.publicOffers(params.slug) }), {
  auth: false,
});
