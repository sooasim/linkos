import { card, forbidden, notFound } from "@linkos/api";
import { parse, route } from "@/lib/server";

// getProfile: owner gets the full profile (incl. private fields); others must use /p/{slug} (ACL-filtered)
export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const p = await card.loadProfile(params.id);
  if (!p) throw notFound("profile");
  if (p.userId !== ctx.userId) throw forbidden();
  return p;
});
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => card.saveProfile(ctx, parse(card.profileInput, body), params.id));
