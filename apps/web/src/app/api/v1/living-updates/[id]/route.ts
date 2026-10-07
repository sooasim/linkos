import { living } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-033 accept (contact updated with provenance 'sync') or dismiss
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => living.resolveLivingUpdate(ctx, params.id, parse(living.livingResolveInput, body)));
