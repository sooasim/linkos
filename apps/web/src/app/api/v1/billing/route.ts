import { billing } from "@linkos/api";
import { route } from "@/lib/server";

// F-190/F-191/F-192 plan, usage meters, subscription state
export const GET = route(async ({ ctx }) => billing.billingSummary(ctx.userId!));
