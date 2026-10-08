import { webhooks, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-123 Webhook/Zapier/Make — the signing secret is returned once
export const GET = route(async ({ ctx }) => webhooks.listEndpoints(ctx.userId!));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(webhooks.endpointInput, body);
  const r = await withIdempotency(`webhook:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await webhooks.createEndpoint(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
