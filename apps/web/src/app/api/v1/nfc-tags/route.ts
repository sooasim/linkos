import { channels } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-044 NFC 액세서리: list / register owner tags.
// The tag id is returned exactly once (it is written to the tag) and only its hash is stored, so this create is
// deliberately not replayed through the Idempotency-Key store (that would persist the raw tag id).
export const GET = route(async ({ ctx }) => ({ tags: await channels.listNfcTags(ctx.userId!) }));

export const POST = route(async ({ ctx, body }) => {
  const r = await channels.registerNfcTag(ctx, parse(channels.nfcTagInput, body));
  return NextResponse.json(r, { status: 201, headers: { "cache-control": "no-store" } });
});
