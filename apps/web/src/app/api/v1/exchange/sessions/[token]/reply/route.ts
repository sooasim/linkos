import { handoff } from "@linkos/api";
import { parse, route } from "@/lib/server";

// replyExchange — guest reciprocates (F-054~F-060). Signed-in receivers also get the reverse relationship.
export const POST = route<{ token: string }>(async ({ ctx, params, body }) => handoff.replyExchange(params.token, ctx, parse(handoff.replyInput, body)), { auth: false, status: 201 });
