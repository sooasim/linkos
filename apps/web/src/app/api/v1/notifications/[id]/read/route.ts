import { inbox } from "@linkos/api";
import { route } from "@/lib/server";

// POST /notifications/{id|all}/read
export const POST = route<{ id: string }>(async ({ ctx, params }) => inbox.markRead(ctx, params.id === "all" ? "all" : params.id));
