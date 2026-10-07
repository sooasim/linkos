import { assist, rateLimit } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-084~F-087: summary/decisions/promises/to-dos/next-meeting suggestions from notes or transcript text
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  await rateLimit(`ai:extract:${ctx.userId}`, 20, 60);
  return assist.extractMeeting(ctx, params.id, parse(z.object({ text: z.string().trim().min(1).max(60_000) }), body).text);
});
