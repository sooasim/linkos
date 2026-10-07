import { living } from "@linkos/api";
import { route } from "@/lib/server";

// F-036 requests received through my Action Card
export const GET = route(async ({ ctx, req }) => ({ requests: await living.listActionRequests(ctx.userId!, req.nextUrl.searchParams.get("status") ?? undefined) }));
