import { passkey } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => ({ passkeys: await passkey.listPasskeys(ctx.userId!) }));
