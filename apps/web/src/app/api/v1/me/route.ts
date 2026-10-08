import { identity } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => identity.getMe(ctx.userId!));
