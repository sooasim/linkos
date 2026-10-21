import { cardSms } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, requestCtx } from "@/lib/server";

// X-009 수신자(비회원)가 누르는 "연락처에 저장". 로그인 없이 동작해야 하므로 route() 가 아니라 직접 처리한다.
// attachment 로 내려보내면 안드로이드/구글 연락처·iOS 연락처가 "연락처 추가" 화면을 띄운다.
export async function GET(req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const ctx = requestCtx(req);
  try {
    const { token } = await context.params;
    const { filename, vcard } = await cardSms.cardSmsVcard(token, ctx);
    return new NextResponse(vcard, {
      status: 200,
      headers: {
        "content-type": "text/vcard; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (e) {
    return errorResponse(e, ctx.requestId);
  }
}
