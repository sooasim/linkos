import { growth } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-181 kill switch
export const POST = route<{ key: string }>(async ({ ctx, params, body }) => growth.killFlag(ctx, params.key, parse(z.object({ killed: z.boolean().default(true) }), body).killed));
