import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-133 org relationship graph (positions computed server-side; personal networks only as company aggregates)
export const GET = route<{ id: string }>(async ({ ctx, params }) => network.orgGraph(ctx, params.id));
