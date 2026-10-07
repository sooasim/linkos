import { ai, rateLimit } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => {
  await rateLimit(`ai:search:${ctx.userId}`, 60, 60);
  return ai.relationshipSearch(ctx, parse(z.object({ query: z.string().trim().min(1).max(300) }), body).query);
});
