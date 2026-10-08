import { channels } from "@linkos/api";
import { route } from "@/lib/server";

// F-052: revoke a device key (lost phone) — its receipts and passes are refused from then on.
export const DELETE = route<{ keyId: string }>(async ({ ctx, params }) => channels.revokeDeviceKey(ctx, params.keyId));
