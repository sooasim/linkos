import { event } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ events: await event.listMyEvents(ctx.userId!) }));
export const POST = route(async ({ ctx, body }) => event.createEvent(ctx, parse(event.eventInput, body)), { status: 201 });
