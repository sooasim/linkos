import { identity } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => {
  const { email } = parse(z.object({ email: z.string().max(200) }), body);
  return identity.requestOtp(ctx, email);
}, { auth: false });
