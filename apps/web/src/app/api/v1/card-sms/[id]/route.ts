import { cardSms } from "@linkos/api";
import { route } from "@/lib/server";

// X-009 초안 취소(= 링크 폐기). 이미 보낸 문자는 되돌릴 수 없으므로 409 로 거절한다.
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => cardSms.cancelCardSms(ctx, params.id));
