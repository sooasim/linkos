import { comms, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-111 템플릿 — personal + team templates
export const GET = route(async ({ ctx }) => comms.listTemplates(ctx.userId!));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(comms.templateInput, body);
  const r = await withIdempotency(`template:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await comms.saveTemplate(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
