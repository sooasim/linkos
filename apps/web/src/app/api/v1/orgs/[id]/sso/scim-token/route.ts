import { enterprise } from "@linkos/api";
import { route } from "@/lib/server";

// F-008 SCIM bearer token (rotating invalidates the previous one; shown once)
export const POST = route<{ id: string }>(async ({ ctx, params }) => enterprise.rotateScimToken(ctx, params.id));
