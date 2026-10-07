import { booth } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-151 organizer API tokens (owner only; plaintext token shown once)
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ tokens: await booth.listOrganizerTokens(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => booth.createOrganizerToken(ctx, params.id, parse(booth.tokenInput, body)), { status: 201 });
