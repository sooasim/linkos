import { connection, intro } from "@linkos/api";
import { parse, route } from "@/lib/server";

// list includes F-159 outcome + F-155 draft presence
export const GET = route(async ({ ctx }) => ({ introductions: await intro.listIntroductionsWithOutcome(ctx) }));
// createIntroduction — consent-based; no contact details revealed before both accept
export const POST = route(async ({ ctx, body }) => connection.createIntroduction(ctx, parse(connection.introInput, body)), { status: 201 });
