import { calendar, rateLimit } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-087 일정 후보 — next-meeting wording → proposed slots (rules/AI provenance, needs approval)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  await rateLimit(`ai:schedule:${ctx.userId}`, 30, 60);
  return calendar.proposeFromMeeting(ctx, params.id, parse(calendar.fromMeetingInput, body));
});
