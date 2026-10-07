import { integration } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// connectGoogle — returns the OAuth URL. purpose=contacts (People) | sheets/drive (drive.file) | gmail (send+compose) | calendar (events+freebusy)
export const POST = route(async ({ ctx, body }) => {
  const { purpose } = parse(z.object({ purpose: z.enum(integration.GOOGLE_PURPOSES).default("contacts") }), body);
  return { url: integration.googleAuthUrl(purpose, ctx.userId).url };
});
