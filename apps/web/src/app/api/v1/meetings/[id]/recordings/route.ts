import { meeting, recording } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-081 createRecording (04_OPENAPI: 202 Processing) — consent gate enforced server-side (principle 7); the recording
// row exists synchronously and parts upload to encrypted storage, transcription/analysis run asynchronously afterwards
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => meeting.createRecording(ctx, params.id, parse(recording.startInput, body)), { status: 202 });
