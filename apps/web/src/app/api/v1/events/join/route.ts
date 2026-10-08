import { event } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => {
  const b = parse(z.object({ joinCode: z.string().trim().min(4).max(12), optIn: z.boolean() }), body);
  return event.joinEvent(ctx, b.joinCode, b.optIn);
});
