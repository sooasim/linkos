import { passkey } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => passkey.authenticationOptions(ctx, parse(z.object({ email: z.string().max(200).nullish() }), body).email), { auth: false });
