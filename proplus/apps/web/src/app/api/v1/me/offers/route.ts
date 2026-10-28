/**
 * P-090 상품 카드 · P-091 가격 표시 정책 · P-141 요금제 한도 — 내 카탈로그 목록·생성.
 * 경로는 데이터모델 §4 (`POST /me/offers`)를 따른다.
 *
 * 이 파일이 지키는 라우트 규약 세 가지 (CLAUDE.md §3 계층 규칙):
 *
 * 1. **모양만 검증한다.** zod 는 "문자열인가·숫자인가·있는가"까지만 본다. 가격 완결성(P-091),
 *    요금제 한도(P-141), 조직 소유 권한(P-089)은 전부 모듈의 판단이다 — 라우트가 같은 판단을
 *    한 번 더 하면 두 곳이 서로 다르게 틀릴 수 있고, 그때 어느 쪽이 진실인지 아무도 모른다.
 * 2. **닫힌 집합은 모듈이 내보낸 상수를 그대로 zod enum 으로 쓴다.** 리터럴을 베껴 두면
 *    모듈이 집합을 늘릴 때 한쪽만 바뀐다.
 * 3. **권한을 계산하지 않는다.** 소유자 스코프는 모듈의 SQL `WHERE profile_id = ...` 안에 있다.
 *
 * `Idempotency-Key` 재생과 CSRF 출처 검사는 `route()` 래퍼가 처리한다 (CLAUDE.md §5).
 */

import { catalog } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * 길이 상한은 **모듈보다 느슨하다**: 모듈이 `sanitizeText(title, 120)` 로 자르는 것이 최종 규칙이고,
 * 여기서는 본문 폭주를 막는 하드 바운드만 둔다. 같은 숫자를 두 곳에 적으면 둘 중 하나가 낡는다.
 *
 * `strictObject` 인 이유: JSON 본문에서 모르는 키는 "클라이언트는 설정했다고 믿는데 서버는 무시한다"는
 * 뜻이다. 가격 필드 오타가 조용히 버려지면 사용자는 가격을 저장했다고 착각한다.
 */
const offerBody = z.strictObject({
  title: z.string().min(1).max(500),
  description: z.string().max(8000).nullable().optional(),
  priceDisplayPolicy: z.enum(catalog.PRICE_POLICIES).optional(),
  priceAmount: z.number().nullable().optional(),
  priceCurrency: z.string().max(8).nullable().optional(),
  externalUrl: z.string().max(2048).nullable().optional(),
  availableUntil: z.string().max(64).nullable().optional(),
  ownerType: z.enum(catalog.OFFER_OWNER_TYPES).optional(),
  organizationId: z.uuid().nullable().optional(),
});

/** P-090: 초안·보관까지 포함한 내 목록. 공개 목록은 `/public/profiles/{slug}/offers` 가 따로 있다. */
export const GET = route(async ({ ctx }) => ({ offers: await catalog.listMyOffers(ctx) }));

/**
 * P-090: 생성은 항상 `draft` 다(모듈이 강제한다). 공개는 `PATCH /me/offers/{id}` 의 `status` 로 하는
 * 별도 행위여야 한다 — 반쯤 쓴 카드가 저장만으로 공개되지 않게.
 */
export const POST = route(
  async ({ ctx, body }) => ({ offer: await catalog.createOffer(ctx, parse(offerBody, body)) }),
  { status: 201 },
);
