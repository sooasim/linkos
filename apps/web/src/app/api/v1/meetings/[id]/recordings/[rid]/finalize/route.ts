import { recording } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string; rid: string }>(async ({ ctx, params, body }) => recording.finalizeRecording(ctx, params.id, params.rid, parse(recording.finalizeInput, body)));
