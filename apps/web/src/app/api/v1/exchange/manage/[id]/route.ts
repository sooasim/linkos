import { handoff } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => handoff.getSenderSessionStatus(ctx, params.id));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => handoff.revokeSession(ctx, params.id));
