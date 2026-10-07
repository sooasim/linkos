import { org } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; inviteId: string }>(async ({ ctx, params }) => org.revokeInvite(ctx, params.id, params.inviteId));
