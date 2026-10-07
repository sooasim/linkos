import { card } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => card.resolveAccessRequest(ctx, params.id, parse(z.object({ approve: z.boolean() }), body).approve));
