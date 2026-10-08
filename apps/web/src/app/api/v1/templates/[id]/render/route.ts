import { comms } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => comms.renderTemplateFor(ctx, params.id, parse(comms.renderInput, body)));
