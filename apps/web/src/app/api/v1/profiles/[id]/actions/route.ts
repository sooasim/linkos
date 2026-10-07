import { living } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-036 owner-side Action Card CTA settings
export const GET = route<{ id: string }>(async ({ ctx, params }) => living.getOwnActionCtas(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => living.setActionCtas(ctx, params.id, parse(living.actionCtasInput, body)));
