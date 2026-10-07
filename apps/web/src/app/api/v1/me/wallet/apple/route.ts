import { shareKit } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// X-004 Apple Wallet .pkpass (501 wallet_not_configured until PASS_CERT/PASS_KEY/WWDR/PASS_TYPE_ID/PASS_TEAM_ID are set)
export const GET = route(async ({ ctx, req }) => {
  const f = await shareKit.applePass(ctx, req.nextUrl.searchParams.get("profileId") ?? undefined);
  return new NextResponse(new Uint8Array(f.body), { headers: { "content-type": "application/vnd.apple.pkpass", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
