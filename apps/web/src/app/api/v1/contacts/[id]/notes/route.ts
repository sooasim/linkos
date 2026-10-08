import { relationship, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// Idempotency-Key: offline-queued notes (F-178) are replayed safely after reconnect (F-179)
export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000), kind: z.enum(["text", "voice"]).default("text") }), body);
  const r = await withIdempotency(`note:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await relationship.addNote(ctx, params.id, b.body, b.kind) }));
  return NextResponse.json(r.body, { status: r.status });
});
