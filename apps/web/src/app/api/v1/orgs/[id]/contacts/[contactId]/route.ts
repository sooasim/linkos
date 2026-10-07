import { org } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string; contactId: string }>(async ({ ctx, params }) => org.getTeamContact(ctx, params.id, params.contactId));
export const DELETE = route<{ id: string; contactId: string }>(async ({ ctx, params }) => org.unshareContact(ctx, params.id, params.contactId));
