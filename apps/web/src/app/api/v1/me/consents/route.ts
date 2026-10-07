import { identity } from "@linkos/api";
import { CONSENT_TYPES } from "@linkos/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const PATCH = route(async ({ ctx, body }) => {
  const b = parse(z.object({ type: z.enum(CONSENT_TYPES), granted: z.boolean() }), body);
  await identity.updateConsent(ctx, b.type, b.granted);
  return { consents: await identity.currentConsents(ctx.userId!) };
});
