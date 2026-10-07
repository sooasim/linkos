import { calendar } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-157 미팅 예약 — joint meeting slots inside a Connection Room
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ candidates: await calendar.listCandidates(ctx.userId!, { roomId: params.id }) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => ({ candidates: await calendar.proposeRoomMeeting(ctx, params.id, parse(calendar.roomMeetingInput, body)) }), { status: 201 });
