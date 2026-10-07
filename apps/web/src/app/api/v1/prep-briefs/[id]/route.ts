import { assistantJobs } from "@linkos/api";
import { route } from "@/lib/server";

// X-005 "만나기 전 30초 브리핑" for one approved calendar entry (records only; AI-inferred topics labelled)
export const GET = route<{ id: string }>(async ({ ctx, params }) => assistantJobs.getPrepBrief(ctx, params.id));
