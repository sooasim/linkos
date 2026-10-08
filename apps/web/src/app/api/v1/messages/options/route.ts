import { comms } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => comms.sendOptions(ctx.userId!));
