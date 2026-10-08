import { recording } from "@linkos/api";
import { route } from "@/lib/server";

// F-082 전사 / F-083 화자분리: segments with speaker keys and timestamps
export const GET = route<{ id: string }>(async ({ ctx, params }) => recording.getTranscript(ctx, params.id));
