import { comms, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-106 메시지 초안 — drafts by default; sending is a separate, explicitly approved call
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  return { messages: await comms.listMessages(ctx.userId!, { contactId: sp.get("contactId") ?? undefined, status: sp.get("status") ?? undefined }) };
});
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(comms.messageInput, body);
  const r = await withIdempotency(`message:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await comms.createMessage(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
