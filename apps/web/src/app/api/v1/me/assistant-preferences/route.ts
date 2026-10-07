import { assistantJobs } from "@linkos/api";
import { parse, route } from "@/lib/server";

// X-005 prep brief lead time (0 = off) · X-006 weekly re-connect digest (+ optional reminder email to myself)
export const GET = route(async ({ ctx }) => assistantJobs.getPrefs(ctx.userId!));
export const PATCH = route(async ({ ctx, body }) => assistantJobs.setPrefs(ctx, parse(assistantJobs.prefsInput, body)));
