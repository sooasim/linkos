import { booth, capture, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-147 booth lead flow (GET list, POST manual lead) + F-144 badge OCR → event lead, F-150 offline replay.
// A body carrying a `capture` key (badge scanner / offline outbox) is a capture commit; anything else is a booth lead.
// Both honour Idempotency-Key so a replayed request creates exactly one lead.
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => ({
  leads: await booth.listLeads(ctx, params.id, { mine: req.nextUrl.searchParams.get("mine") === "1", grade: req.nextUrl.searchParams.get("grade") ?? undefined }),
}));
export const POST = route<{ id: string }>(async ({ ctx, body, req, params }) => {
  const isCapture = !!body && typeof body === "object" && "capture" in (body as object);
  const r = await withIdempotency(`lead:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () =>
    isCapture
      ? { status: 201, body: await capture.commitCapture(ctx, parse(capture.commitInput, { ...(body as object), eventId: params.id })) }
      : { status: 201, body: await booth.captureLead(ctx, params.id, parse(booth.leadInput, body)) },
  );
  return NextResponse.json(r.body, { status: r.status });
});
