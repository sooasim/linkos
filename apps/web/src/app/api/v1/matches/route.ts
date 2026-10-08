import { ai } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => ai.listMatches(ctx, { eventId: req.nextUrl.searchParams.get("eventId") ?? undefined }));
