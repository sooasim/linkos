import { card } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ requests: await card.listIncomingAccessRequests(ctx.userId!) }));
