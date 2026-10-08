import { push } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => push.subscribe(ctx, parse(push.subscriptionInput, body)), { status: 201 });
export const DELETE = route(async ({ ctx, body }) => push.unsubscribe(ctx, parse(z.object({ endpoint: z.string().url() }), body).endpoint));
