import { comms, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-105 후속 메시지 — sequence of dated drafts/reminders; nothing is sent automatically
export const GET = route(async ({ ctx, req }) => ({ sequences: await comms.listSequences(ctx.userId!, req.nextUrl.searchParams.get("contactId") ?? undefined) }));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(comms.sequenceInput, body);
  const r = await withIdempotency(`sequence:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await comms.createSequence(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
