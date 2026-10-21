import { cardSms } from "@linkos/api";
import { uploadRoute } from "@/lib/upload";

// X-009 문자에 실어 보낼 내 명함 이미지(PNG). 화면의 캔버스가 그린 결과를 그대로 올리고,
// 서버는 검사·재인코딩 후 암호화해 저장한다(F-172 / files.storeObject).
export const POST = uploadRoute(async ({ ctx, bytes, search }) => cardSms.putCardImage(ctx, bytes, search.get("profileId")), {
  maxBytes: 8 * 1024 * 1024,
  idempotencyScope: "card-sms-image",
});
