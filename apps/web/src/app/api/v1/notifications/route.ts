import { push } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ notifications: await push.listNotifications(ctx.userId!) }));
