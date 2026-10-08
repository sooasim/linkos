import { passkey } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => passkey.deletePasskey(ctx, params.id));
