import { channels } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-046: sender enters the code the receiver reads out; matched only inside the receiver's time window.
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => channels.matchRendezvous(ctx, params.id, parse(z.object({ code: z.string().max(12) }), body).code));
