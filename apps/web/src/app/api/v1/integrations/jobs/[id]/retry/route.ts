import { crm } from "@linkos/api";
import { route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params }) => crm.retryJob(ctx, params.id));
