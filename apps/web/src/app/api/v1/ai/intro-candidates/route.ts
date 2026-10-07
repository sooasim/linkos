import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-097 / F-152 AI 소개 후보 (Need↔Offer + relationship strength; explainable, ai_inferred)
export const GET = route(async ({ ctx }) => network.introSuggestions(ctx));
