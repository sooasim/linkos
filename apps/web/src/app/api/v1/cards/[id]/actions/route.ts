import { living, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-036 public Action Card: list CTAs, submit a request (guest-accessible, consented, rate limited)
export const GET = route<{ id: string }>(async ({ params }) => living.getActionCtas(params.id), { auth: false });
export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(living.actionRequestInput, body);
  const r = await withIdempotency(`action:${params.id}:${ctx.userId ?? ctx.ip}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await living.submitActionRequest(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
}, { auth: false });
