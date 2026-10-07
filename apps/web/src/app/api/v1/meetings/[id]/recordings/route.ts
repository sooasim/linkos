import { meeting } from "@linkos/api";
import { route } from "@/lib/server";

// createRecording — consent gate enforced server-side (F-084)
export const POST = route<{ id: string }>(async ({ ctx, params }) => meeting.createRecording(ctx, params.id), { status: 202 });
