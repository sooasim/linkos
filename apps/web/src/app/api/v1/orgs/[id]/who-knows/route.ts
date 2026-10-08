import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-134 who in my org knows someone at company X (strength-ranked)
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => network.whoKnows(ctx, params.id, (req.nextUrl.searchParams.get("company") ?? "").slice(0, 100)));
