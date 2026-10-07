import { booth } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; tokenId: string }>(async ({ ctx, params }) => booth.revokeOrganizerToken(ctx, params.id, params.tokenId));
