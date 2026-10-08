import { card, forbidden, notFound, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// getProfile: owner gets the full profile (incl. private fields); others must use /p/{slug} (ACL-filtered)
export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const p = await card.loadProfile(params.id);
  if (!p) throw notFound("profile");
  if (p.userId !== ctx.userId) throw forbidden();
  return p;
});
export const PATCH = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(card.profileInput, body);
  const r = await withIdempotency(`profile-update:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await card.saveProfile(ctx, input, params.id) }));
  return NextResponse.json(r.body, { status: r.status });
});
