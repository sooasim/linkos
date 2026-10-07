import { shareKit } from "@linkos/api";
import { route } from "@/lib/server";

// X-002 virtual background: card text + tracked link (the 1920×1080 PNG is rendered client-side)
export const GET = route(async ({ ctx, req }) => shareKit.backgroundData(ctx, req.nextUrl.searchParams.get("profileId") ?? undefined));
