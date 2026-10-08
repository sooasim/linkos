import { push } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const PATCH = route(async ({ ctx, body }) => push.setPreferences(ctx, parse(push.prefsInput, body)));
