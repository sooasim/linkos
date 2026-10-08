import { push } from "@linkos/api";
import { route } from "@/lib/server";

// F-110 push delivery log (the in-app inbox lives at /notifications)
export const GET = route(async ({ ctx }) => ({ notifications: await push.listNotifications(ctx.userId!) }));
