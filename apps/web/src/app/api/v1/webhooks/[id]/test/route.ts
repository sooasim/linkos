import { webhooks } from "@linkos/api";
import { route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params }) => webhooks.testEndpoint(ctx, params.id));
