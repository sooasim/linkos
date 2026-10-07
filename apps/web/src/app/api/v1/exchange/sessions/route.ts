import { handoff, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// createExchangeSession (F-037 공유 1탭, F-038 capability, F-050 token)
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(handoff.createSessionInput, body);
  const r = await withIdempotency(`xch:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await handoff.createExchangeSession(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});

export const GET = route(async ({ ctx }) => ({ sessions: await handoff.recentSessions(ctx.userId!) }));
