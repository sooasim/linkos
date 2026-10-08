import { relationship } from "@linkos/api";
import { route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params }) => relationship.undoMerge(ctx, params.id));
