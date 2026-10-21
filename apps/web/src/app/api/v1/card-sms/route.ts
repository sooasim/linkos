import { cardSms } from "@linkos/api";
import { parse, route } from "@/lib/server";

// X-009 문자 명함 전송 — 초안(링크 + 본문) 만들기 / 보낸 목록.
// 발송은 별도 승인 호출(POST /card-sms/{id}/send)에서만 일어난다.
export const GET = route(async ({ ctx, req }) => {
  const preview = req.nextUrl.searchParams.get("preview") === "1";
  if (preview) return cardSms.cardSmsPreview(ctx, req.nextUrl.searchParams.get("profileId"));
  return { deliveries: await cardSms.listCardSms(ctx.userId!) };
});

export const POST = route(async ({ ctx, body }) => cardSms.prepareCardSms(ctx, parse(cardSms.prepareInput, body)), { status: 201 });
