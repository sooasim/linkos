import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string; userId: string }>(async ({ ctx, params, body }) => org.approveMember(ctx, params.id, params.userId, parse(z.object({ approve: z.boolean() }), body).approve));
