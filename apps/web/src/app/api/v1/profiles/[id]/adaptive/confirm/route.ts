import { living } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => living.adaptiveConfirm(ctx, params.id, parse(living.adaptiveConfirmInput, body)));
