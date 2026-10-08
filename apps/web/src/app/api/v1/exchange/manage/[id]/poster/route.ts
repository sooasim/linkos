import { shareKit } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// X-007 printable A6/A4 poster or table tent for a group exchange (short code first, QR small)
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const size = req.nextUrl.searchParams.get("size") === "a4" ? "a4" : "a6";
  const f = await shareKit.eventPoster(ctx, params.id, size);
  return new NextResponse(new Uint8Array(f.body), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
