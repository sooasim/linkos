import { meeting } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => meeting.getMeeting(ctx.userId!, params.id));
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => meeting.saveMeeting(ctx, parse(meeting.meetingInput, body), params.id));
