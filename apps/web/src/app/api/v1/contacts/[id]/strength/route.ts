import { network } from "@linkos/api";
import { route } from "@/lib/server";

// F-074 explainable relationship strength
export const GET = route<{ id: string }>(async ({ ctx, params }) => network.strengthFor(ctx, params.id));
