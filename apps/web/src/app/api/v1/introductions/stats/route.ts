import { intro } from "@linkos/api";
import { route } from "@/lib/server";

// F-159 소개 성과
export const GET = route(async ({ ctx }) => intro.introOutcomeStats(ctx));
