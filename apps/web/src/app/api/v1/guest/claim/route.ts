import { handoff } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// claimGuest (F-003)
export const POST = route(async ({ ctx, body }) => handoff.claimGuest(ctx, parse(z.object({ claimToken: z.string().max(200) }), body).claimToken));
