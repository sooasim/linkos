import { assistantJobs } from "@linkos/api";
import { route } from "@/lib/server";

// X-005 upcoming approved meetings (next 7 days) that get a 30-second brief
export const GET = route(async ({ ctx }) => assistantJobs.upcomingBriefs(ctx));
