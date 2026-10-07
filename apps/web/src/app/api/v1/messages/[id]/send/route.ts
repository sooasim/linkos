import { comms, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-106 이메일 발송 — requires { approved: true } from the user (high-risk action), Gmail → Outlook → SMTP
export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(comms.sendInput, body);
  const r = await withIdempotency(`message-send:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await comms.sendMessage(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
