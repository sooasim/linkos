import { assistantJobs } from "@linkos/api";
import { route } from "@/lib/server";

// X-006 this week's re-connect digest (3 cooling relationships, ai_inferred)
export const GET = route(async ({ ctx }) => assistantJobs.currentDigest(ctx));
