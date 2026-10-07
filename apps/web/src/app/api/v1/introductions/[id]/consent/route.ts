import { connection } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(z.object({ party: z.enum(["a", "b"]), accepted: z.boolean() }), body);
  return connection.recordIntroConsent(ctx, params.id, b.party, b.accepted);
});
