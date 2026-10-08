import { meeting } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => ({ followups: await meeting.listFollowups(ctx.userId!, req.nextUrl.searchParams.get("status") === "done" ? "done" : "open") }));
export const POST = route(async ({ ctx, body }) => meeting.createFollowup(ctx, parse(meeting.followupInput, body)), { status: 201 });
