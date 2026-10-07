import { channels } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-052: upload queued, device-signed exchange receipts after reconnecting. Idempotent per (device key, receipt id).
export const POST = route(async ({ ctx, body }) => channels.syncOfflineReceipts(ctx, parse(channels.syncReceiptsInput, body)));
