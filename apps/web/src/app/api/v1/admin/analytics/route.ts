import { growth } from "@linkos/api";
import { route } from "@/lib/server";

// F-188 funnels, F-189 viral loop, F-187 cost (platform admins only)
export const GET = route(async ({ ctx, req }) => {
  const days = Math.min(365, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30);
  const funnel = await growth.funnelReport(ctx, days);
  const viral = await growth.adminViral(ctx, days);
  const cost = await growth.costReport(ctx, days);
  const kpis = await growth.kpiReport(ctx, days); // 백서 §23 Retention / Match-to-Meeting / Enterprise Active Relationships + §20 RUM
  return { funnel, viral, cost, kpis };
});
