import { calendar, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-108 일정 승인 — candidate list + manual proposals
export const GET = route(async ({ ctx, req }) => ({ candidates: await calendar.listCandidates(ctx.userId!, parse(calendar.listCandidatesQuery, Object.fromEntries(req.nextUrl.searchParams))) }));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(calendar.manualCandidatesInput, body);
  const r = await withIdempotency(`candidates:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await calendar.createCandidates(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
