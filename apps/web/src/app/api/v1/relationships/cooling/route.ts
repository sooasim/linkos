import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-098 미접촉 위험 (ai_inferred, with reasons)
export const GET = route(async ({ ctx }) => network.coolingRelationships(ctx));
