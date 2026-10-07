import { channels } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-039/F-040: receiver app resolves a consistently-close advertiser (RSSI evaluated on device; re-checked here).
const schema = z.object({ ephemeralId: z.string().max(32), rssi: z.number().int().min(-127).max(0) });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body);
  return channels.resolveProximity(ctx, b.ephemeralId, b.rssi);
});
