import { shareKit } from "@linkos/api";
import { route } from "@/lib/server";

// X-004 Google Wallet generic object (+ signed save link when GOOGLE_WALLET_* is configured)
export const GET = route(async ({ ctx, req }) => shareKit.googleWallet(ctx, req.nextUrl.searchParams.get("profileId") ?? undefined));
