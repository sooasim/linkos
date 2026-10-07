import { living } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => living.updateActionRequest(ctx, params.id, parse(z.object({ status: z.enum(["in_progress", "done", "declined"]) }), body).status));
