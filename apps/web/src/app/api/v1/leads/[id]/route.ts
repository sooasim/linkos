import { booth } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => booth.updateLead(ctx, params.id, parse(booth.leadPatch, body)));
