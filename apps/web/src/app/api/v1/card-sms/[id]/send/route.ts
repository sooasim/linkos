import { cardSms } from "@linkos/api";
import { parse, route } from "@/lib/server";

// X-009 발송 — §2.8 고위험 자동행동: `approved: true` 가 없으면 보내지 않는다. 한 번의 승인 = 한 건.
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => cardSms.sendCardSms(ctx, params.id, parse(cardSms.sendCardSmsInput, body)));
