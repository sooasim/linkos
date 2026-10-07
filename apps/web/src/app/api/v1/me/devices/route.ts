import { identity } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ devices: await identity.listDevices(ctx.userId!) }));
