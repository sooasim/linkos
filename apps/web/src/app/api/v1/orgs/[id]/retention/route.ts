import { enterprise } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-136 Data Retention: preview what the worker would purge, update the policy
export const GET = route<{ id: string }>(async ({ ctx, params }) => enterprise.previewRetention(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => enterprise.updateRetention(ctx, params.id, parse(enterprise.retentionInput, body)));
