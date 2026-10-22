import { cardSms } from "@linkos/api";
import { parse, route } from "@/lib/server";

// X-009 내 안드로이드 폰(공식 Android SMS Gateway 앱, Cloud 모드) 연결.
// 인증정보는 봉인해 저장하고 응답으로 되돌려주지 않는다. 엔드포인트는 서버에 고정돼 있어 임의 URL 로 나가지 않는다.
export const PUT = route(async ({ ctx, body }) => cardSms.saveGateway(ctx, parse(cardSms.gatewayInput, body)));

export const DELETE = route(async ({ ctx }) => cardSms.removeGateway(ctx));
