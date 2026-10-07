import { relationship } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => relationship.contactTimeline(ctx.userId!, params.id));
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => relationship.updateContact(ctx, params.id, parse(relationship.contactInput.partial(), body)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => {
  await relationship.deleteContact(ctx, params.id);
  return { ok: true };
});
