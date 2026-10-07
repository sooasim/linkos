import { webhooks } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ deliveries: await webhooks.listDeliveries(ctx, params.id) }));
