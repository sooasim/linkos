import { cardViews } from "@linkos/api";
import { route } from "@/lib/server";

// X-003 card view analytics for /app/insights (30-day series, per session and per profile)
export const GET = route(async ({ ctx, req }) => cardViews.cardViewInsights(ctx.userId!, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
