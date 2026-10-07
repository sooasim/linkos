import { calendar } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-146 행사 미팅 요청 — 1:1 with an opted-in attendee
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ requests: await calendar.listEventMeetingRequests(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => calendar.requestEventMeeting(ctx, params.id, parse(calendar.eventMeetingInput, body)), { status: 201 });
