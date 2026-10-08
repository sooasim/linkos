import { living } from "@linkos/api";
import { route } from "@/lib/server";

// F-033 pending Living Update suggestions
export const GET = route(async ({ ctx }) => ({ updates: await living.listLivingUpdates(ctx.userId!) }));
