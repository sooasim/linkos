import { handoff } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({
  channel: z.enum(["ble_proximity", "os_share", "nfc_accessory", "short_code", "web_rendezvous", "acoustic", "local_receipt", "qr"]),
  outcome: z.enum(["success", "failed", "cancelled", "timeout", "unsupported"]),
  latencyMs: z.number().int().min(0).max(3_600_000).optional(),
  reason: z.string().max(120).optional(),
});

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(schema, body);
  return handoff.recordAttempt(ctx, params.id, b.channel, b.outcome, b.latencyMs, b.reason);
});
