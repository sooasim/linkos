import { calendar } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => calendar.calendarStatus(ctx.userId!));
