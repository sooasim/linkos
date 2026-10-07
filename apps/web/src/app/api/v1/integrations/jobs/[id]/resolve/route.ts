import { crm } from "@linkos/api";
import { parse, route } from "@/lib/server";

// conflicts are resolved only by an explicit user decision
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => crm.resolveConflict(ctx, params.id, parse(crm.resolveInput, body).strategy));
