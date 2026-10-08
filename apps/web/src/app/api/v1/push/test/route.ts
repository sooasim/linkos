import { push } from "@linkos/api";
import { route } from "@/lib/server";

export const POST = route(async ({ ctx }) => push.sendTestPush(ctx));
