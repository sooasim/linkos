import { meeting } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ meetings: await meeting.listMeetings(ctx.userId!) }));
export const POST = route(async ({ ctx, body }) => meeting.saveMeeting(ctx, parse(meeting.meetingInput, body)), { status: 201 });
