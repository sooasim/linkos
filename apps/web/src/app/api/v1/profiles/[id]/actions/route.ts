import { living, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-036 owner-side Action Card CTA settings (+ F-021 CTA icons; unknown icon/emoji → 400)
export const GET = route<{ id: string }>(async ({ ctx, params }) => living.getOwnActionCtas(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(living.actionCtasInput, body);
  const r = await withIdempotency(`profile-actions:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await living.setActionCtas(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
