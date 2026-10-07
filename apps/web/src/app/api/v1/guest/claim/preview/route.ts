import { handoff } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ body }) => handoff.previewClaim(parse(z.object({ claimToken: z.string().max(200) }), body).claimToken), { auth: false });
