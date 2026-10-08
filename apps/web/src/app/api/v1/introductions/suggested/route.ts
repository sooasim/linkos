import { connection, intro } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-152 → create a consent-based introduction from an AI candidate
export const POST = route(async ({ ctx, body }) => intro.createFromSuggestion(ctx, parse(connection.introInput, body)), { status: 201 });
