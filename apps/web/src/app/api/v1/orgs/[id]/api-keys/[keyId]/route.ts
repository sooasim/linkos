import { enterprise } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; keyId: string }>(async ({ ctx, params }) => enterprise.revokeApiKey(ctx, params.id, params.keyId));
