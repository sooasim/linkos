import { integration } from "@linkos/api";
import { route } from "@/lib/server";

// syncGoogleContacts — idempotent, queued; worker serializes per account
export const POST = route(async ({ ctx }) => integration.enqueueGoogleContactSync(ctx), { status: 202 });
