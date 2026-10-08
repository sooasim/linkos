import { cardViews } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// X-003 analytics opt-out (opting out also deletes collected card view counts)
export const GET = route(async ({ ctx }) => cardViews.getPreference(ctx.userId!));
export const PATCH = route(async ({ ctx, body }) => cardViews.setPreference(ctx, parse(z.object({ optOut: z.boolean() }), body).optOut));
