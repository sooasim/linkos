import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => netintel.deleteAlias(ctx, params.id));
