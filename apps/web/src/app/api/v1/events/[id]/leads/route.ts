import { capture, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-144 배지 OCR → 행사 리드, F-150 오프라인 모드(재전송 시 Idempotency-Key 로 1회만 생성)
export const POST = route<{ id: string }>(async ({ ctx, body, req, params }) => {
  const input = parse(capture.commitInput, { ...(body as object), eventId: params.id });
  const r = await withIdempotency(`lead:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await capture.commitCapture(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
