import { inbox } from "@linkos/api";
import { route } from "@/lib/server";

// in-app notification center
export const GET = route(async ({ ctx, req }) => ({
  notifications: await inbox.listNotifications(ctx.userId!, { unreadOnly: req.nextUrl.searchParams.get("unread") === "1" }),
  unread: await inbox.unreadCount(ctx.userId!),
}));
