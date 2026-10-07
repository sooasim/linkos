import { push } from "@linkos/api";
import { route } from "@/lib/server";

// F-110 Web Push — VAPID public key, this user's subscriptions and preferences
export const GET = route(async ({ ctx }) => push.pushConfig(ctx.userId!));
