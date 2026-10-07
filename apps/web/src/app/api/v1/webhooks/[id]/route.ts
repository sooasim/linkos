import { webhooks } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => webhooks.updateEndpoint(ctx, params.id, parse(webhooks.endpointPatch, body)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => webhooks.deleteEndpoint(ctx, params.id));
