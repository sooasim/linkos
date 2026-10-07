import { integration } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// connectGoogle — returns the OAuth URL. purpose=contacts (People API) | sheets (drive.file, least privilege)
export const POST = route(async ({ ctx, body }) => {
  const { purpose } = parse(z.object({ purpose: z.enum(["contacts", "sheets"]).default("contacts") }), body);
  return { url: integration.googleAuthUrl(purpose, ctx.userId).url };
});
