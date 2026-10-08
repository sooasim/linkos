import { growth } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const PUT = route<{ key: string }>(async ({ ctx, params, body }) => growth.upsertFlag(ctx, params.key, parse(growth.flagInput, body)));
