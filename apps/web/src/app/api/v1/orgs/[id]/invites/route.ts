import { org } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ invites: await org.listInvites(ctx, params.id) }));
// F-004 invite link (token hashed in DB, shown once)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => org.createInvite(ctx, params.id, parse(org.inviteInput, body)), { status: 201 });
