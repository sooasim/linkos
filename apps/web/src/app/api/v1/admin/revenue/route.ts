import { billing } from "@linkos/api";
import { route } from "@/lib/server";

// F-195 MRR/ARR/churn/ARPU (platform admins only)
export const GET = route(async ({ ctx }) => billing.revenueReport(ctx));
