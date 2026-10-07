import { intro } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => intro.setIntroOutcome(ctx, params.id, parse(intro.outcomeInput, body)));
