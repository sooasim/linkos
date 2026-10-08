import { card, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// X-008 setProfileTemplate — gallery "적용". Unknown template / disallowed accent / unknown icon → 400. Idempotency-Key supported.
export const PUT = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(card.profileTemplateInput, body);
  const r = await withIdempotency(`profile-template:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await card.setProfileTemplate(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
