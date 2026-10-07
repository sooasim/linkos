import { comms } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => comms.getMessage(ctx.userId!, params.id));
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => comms.updateMessage(ctx, params.id, parse(comms.messagePatch, body)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => comms.cancelMessage(ctx, params.id));
