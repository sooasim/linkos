import { shareKit } from "@linkos/api";
import { route } from "@/lib/server";

// X-001 email signatures (3 styles, HTML + plain text) with a tracked /p/[slug]?src=sig link
export const GET = route(async ({ ctx, req }) => shareKit.emailSignatures(ctx, req.nextUrl.searchParams.get("profileId") ?? undefined));
