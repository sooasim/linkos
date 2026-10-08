import { capture, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-178/F-052 offline capture replay + F-014 badge: OCR lines + reviewed contact in one transaction (Idempotency-Key)
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(capture.commitInput, body);
  const r = await withIdempotency(`commit:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await capture.commitCapture(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
