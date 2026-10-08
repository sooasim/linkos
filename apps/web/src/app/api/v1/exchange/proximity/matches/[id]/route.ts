import { channels } from "@linkos/api";
import { route } from "@/lib/server";

// F-040: either participant polls the match state (pending → exchanged | rejected | expired).
export const GET = route<{ id: string }>(async ({ ctx, params }) => channels.getProximityMatch(ctx, params.id));
