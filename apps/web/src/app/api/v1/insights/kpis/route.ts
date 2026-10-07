import { analytics } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => analytics.exchangeKpis(ctx.userId!, Math.min(365, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30)));
