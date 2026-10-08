// F-078/F-109 후속 할 일 — POST honours Idempotency-Key (CLAUDE.md §3: every create API) so a retried tap never duplicates a task
import { meeting, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => ({ followups: await meeting.listFollowups(ctx.userId!, req.nextUrl.searchParams.get("status") === "done" ? "done" : "open") }));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(meeting.followupInput, body);
  const r = await withIdempotency(`followup:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await meeting.createFollowup(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
