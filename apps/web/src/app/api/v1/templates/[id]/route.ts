import { comms } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => comms.saveTemplate(ctx, parse(comms.templateInput, body), params.id));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => comms.deleteTemplate(ctx, params.id));
