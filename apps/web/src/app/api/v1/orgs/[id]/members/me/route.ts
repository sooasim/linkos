import { org } from "@linkos/api";
import { parse, route } from "@/lib/server";

// my membership preferences: who-knows-whom opt-out, org branding on my card
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => org.updateMyMembership(ctx, params.id, parse(org.memberPrefsInput, body)));
