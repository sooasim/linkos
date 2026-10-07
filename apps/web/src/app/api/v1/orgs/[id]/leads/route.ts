import { org, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-132 company-owned lead (the org owns it; assignee = 담당자)
export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(org.leadInput, body);
  const r = await withIdempotency(`lead:${params.id}:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await org.createLead(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
