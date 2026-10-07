import { calendar } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => calendar.respondEventMeeting(ctx, params.id, parse(calendar.eventMeetingResponse, body)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => calendar.cancelEventMeetingRequest(ctx, params.id));
