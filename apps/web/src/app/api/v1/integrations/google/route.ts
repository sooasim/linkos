import { integration } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route(async ({ ctx }) => {
  await integration.disconnectGoogle(ctx);
  return { ok: true };
});
