import { meeting } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => meeting.completeFollowup(ctx, params.id, parse(z.object({ status: z.enum(["done", "dismissed", "open"]) }), body).status));
