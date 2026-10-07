import { integration } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => integration.integrationStatus(ctx.userId!));
