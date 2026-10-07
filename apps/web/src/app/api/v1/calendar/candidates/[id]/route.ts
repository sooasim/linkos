import { calendar } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => calendar.cancelCandidate(ctx, params.id));
