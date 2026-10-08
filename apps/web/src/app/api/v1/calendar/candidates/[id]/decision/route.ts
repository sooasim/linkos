import { calendar, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-108 일정 승인 — approve (→ Google/Outlook event, idempotent) or decline
export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(calendar.decideInput, body);
  const r = await withIdempotency(`candidate:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await calendar.decideCandidate(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
