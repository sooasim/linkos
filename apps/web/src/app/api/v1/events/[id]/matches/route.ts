import { event } from "@linkos/api";
import { route } from "@/lib/server";

// eventMatches — only opted-in attendees, explainable reasons
export const GET = route<{ id: string }>(async ({ ctx, params }) => event.eventMatches(ctx, params.id));
