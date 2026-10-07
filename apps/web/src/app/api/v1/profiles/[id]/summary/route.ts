import { assist, rateLimit } from "@linkos/api";
import { route } from "@/lib/server";

// F-091 AI profile summary (suggestion, labeled; Claude when configured, rules otherwise)
export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  await rateLimit(`ai:summary:${ctx.userId}`, 30, 60);
  return assist.summarizeProfile(ctx, params.id);
});
