import { enterprise } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ logs: await enterprise.orgAuditLog(ctx, params.id) }));
