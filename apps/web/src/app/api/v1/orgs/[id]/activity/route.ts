import { enterprise } from "@linkos/api";
import { route } from "@/lib/server";

// F-135 org activity dashboard (manager+)
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => enterprise.orgActivity(ctx, params.id, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
