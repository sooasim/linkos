import { channels } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-052 오프라인 큐: register a per-device HMAC key. The secret is returned once (kept in the OS secure store) and
// stored encrypted server-side; not replayed via Idempotency-Key so it is never persisted in plaintext.
export const POST = route(async ({ ctx, body }) => {
  const r = await channels.registerDeviceKey(ctx, parse(channels.deviceKeyInput, body));
  return NextResponse.json(r, { status: 201, headers: { "cache-control": "no-store" } });
});
