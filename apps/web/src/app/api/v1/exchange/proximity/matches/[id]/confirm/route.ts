import { channels } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-040: both people confirm the same on-screen code; the second confirmation performs the exchange.
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => channels.confirmProximity(ctx, params.id, parse(z.object({ accept: z.boolean() }), body).accept));
