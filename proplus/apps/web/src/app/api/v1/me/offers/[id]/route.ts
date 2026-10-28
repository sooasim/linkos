/**
 * P-090 상품 수정·삭제 · P-092 품절·만료 비공개 — 데이터모델 §4 (`PATCH /me/offers/{id}`).
 *
 * ## 왜 `status` 가 같은 PATCH 에 들어오는가
 *
 * 데이터모델 §4 는 상품에 `PATCH /me/offers/{id}` 하나만 둔다. 모듈은 내용 수정(`updateOffer`)과
 * 상태 전환(`setOfferStatus`)을 **일부러 분리**해 두었다 — 공개/품절이 내용 저장의 부수효과가 되면
 * 안 되기 때문이다(`catalog.ts` 주석). 그래서 라우트가 "본문에 무엇이 왔는지"로 두 모듈 함수에
 * 디스패치한다. 이것은 비즈니스 분기가 아니라 **어댑터의 일**이다: 라우트는 상태 전환이 허용되는지,
 * 가격이 완결됐는지, 누가 소유자인지 하나도 판단하지 않는다.
 *
 * 두 필드가 함께 오면 내용 → 상태 순서로 두 번 호출한다. 각각 자기 트랜잭션에서 `product.updated`
 * 를 outbox 에 적으므로(P-183) 중간에 끊겨도 "가격은 바뀌었는데 아무도 모른다"는 생기지 않는다.
 */

import { badRequest, catalog } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * 부분 수정이므로 모든 필드가 optional 이다. 모듈의 `updateOffer` 는 `undefined` 필드를 기존 값으로
 * 채우도록 구현돼 있다(`input.title === undefined ? before.title : ...`).
 */
const offerPatchBody = z.strictObject({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(8000).nullable().optional(),
  priceDisplayPolicy: z.enum(catalog.PRICE_POLICIES).optional(),
  priceAmount: z.number().nullable().optional(),
  priceCurrency: z.string().max(8).nullable().optional(),
  externalUrl: z.string().max(2048).nullable().optional(),
  availableUntil: z.string().max(64).nullable().optional(),
  status: z.enum(catalog.OFFER_STATUSES).optional(),
});

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => {
  const { status, ...content } = parse(offerPatchBody, body);

  // 빈 PATCH 를 통과시키면 아무 변화 없이 `product.updated` 이벤트만 쌓인다.
  if (status === undefined && Object.keys(content).length === 0) {
    throw badRequest("empty_patch", "수정할 필드를 하나 이상 보내세요.");
  }

  let offer: catalog.Offer | null = null;
  if (Object.keys(content).length > 0) {
    // 캐스트 이유: 모듈은 모든 필드를 optional 로 **취급**하지만 `OfferInput` 은 `title` 을 required 로
    // **선언**한다. 부분 수정 요청을 그대로 넘기기 위해 여기서 좁힌다.
    // TODO: `OfferInput` 을 생성용/수정용으로 나누는 것은 모듈 소유자 PR 이다(계약 이탈 보고 대상).
    offer = await catalog.updateOffer(ctx, params.id, content as catalog.OfferInput);
  }
  if (status !== undefined) offer = await catalog.setOfferStatus(ctx, params.id, status);

  return { offer };
});

/** 삭제도 공개 카탈로그를 바꾸므로 모듈이 `product.updated`(payload `deleted:true`)를 적는다. */
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => catalog.deleteOffer(ctx, params.id));
