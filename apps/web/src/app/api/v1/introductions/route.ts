import { connection } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ introductions: await connection.listIntroductions(ctx) }));
// createIntroduction — consent-based; no contact details revealed before both accept
export const POST = route(async ({ ctx, body }) => connection.createIntroduction(ctx, parse(connection.introInput, body)), { status: 201 });
