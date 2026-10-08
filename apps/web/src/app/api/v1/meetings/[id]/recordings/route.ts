import { meeting, recording } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-081 createRecording — consent gate enforced server-side (principle 7); parts upload to encrypted storage
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => meeting.createRecording(ctx, params.id, parse(recording.startInput, body)), { status: 201 });
