import { card } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ profiles: await card.listMyProfiles(ctx.userId!) }));
export const POST = route(async ({ ctx, body }) => card.saveProfile(ctx, parse(card.profileInput, body)), { status: 201 });
