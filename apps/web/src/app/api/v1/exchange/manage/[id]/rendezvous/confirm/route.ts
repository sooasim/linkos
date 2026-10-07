import { channels } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-046: sender confirms the matched receiver (proves possession of the exchange token).
const schema = z.object({ rendezvousId: z.string().uuid(), token: z.string().max(200), accept: z.boolean() });

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(schema, body);
  return channels.confirmRendezvous(ctx, params.id, b.rendezvousId, b.token, b.accept);
});
