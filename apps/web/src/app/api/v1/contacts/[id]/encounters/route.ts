import { relationship, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ placeLabel: z.string().max(200).optional(), note: z.string().max(2000).optional(), occurredAt: z.string().datetime().optional(), eventId: z.string().uuid().optional() });

export const POST = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(schema, body);
  const r = await withIdempotency(`encounter:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await relationship.addEncounter(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
