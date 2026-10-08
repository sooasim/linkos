import { card, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ profiles: await card.listMyProfiles(ctx.userId!) }));
// createProfile — Idempotency-Key replays the same 201 response (F-021 template fields are part of the body)
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(card.profileInput, body);
  const r = await withIdempotency(`profile-create:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await card.saveProfile(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
