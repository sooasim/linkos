import { enterprise } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-139 policy enforcement settings
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => enterprise.updatePolicies(ctx, params.id, parse(enterprise.policiesInput, body)));
