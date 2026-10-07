import { assist, rateLimit } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-104 follow-up email draft — never sent automatically
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  await rateLimit(`ai:draft:${ctx.userId}`, 30, 60);
  return assist.draftFollowup(ctx, params.id, parse(z.object({ kind: z.enum(["thank_you", "check_in", "send_material"]).default("thank_you") }), body).kind);
});
