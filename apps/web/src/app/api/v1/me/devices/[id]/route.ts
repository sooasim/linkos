import { identity } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => {
  await identity.revokeDevice(ctx, params.id);
  return { ok: true };
});
