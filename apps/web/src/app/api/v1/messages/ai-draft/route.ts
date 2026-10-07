import { comms, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-104 AI 감사메일 → saved as a message draft (AI label, needs confirmation, never auto-sent)
const input = z.object({ contactId: z.string().uuid(), kind: z.enum(["thank_you", "check_in", "send_material"]).default("thank_you") });
export const POST = route(async ({ ctx, body, req }) => {
  const b = parse(input, body);
  const r = await withIdempotency(`ai-draft:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await comms.createAiDraft(ctx, b.contactId, b.kind) }));
  return NextResponse.json(r.body, { status: r.status });
});
