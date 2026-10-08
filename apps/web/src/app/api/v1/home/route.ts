import { analytics } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => analytics.myHome(ctx.userId!));
