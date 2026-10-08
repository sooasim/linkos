import { relationship, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => relationship.contactTimeline(ctx.userId!, params.id));
// version → 409 version_conflict (F-179 conflict UI); Idempotency-Key makes offline replays safe
export const PATCH = route<{ id: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(relationship.contactInput.partial(), body);
  const r = await withIdempotency(`contact-update:${ctx.userId}:${params.id}`, req.headers.get("idempotency-key"), body, async () => ({ status: 200, body: await relationship.updateContact(ctx, params.id, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => {
  await relationship.deleteContact(ctx, params.id);
  return { ok: true };
});
