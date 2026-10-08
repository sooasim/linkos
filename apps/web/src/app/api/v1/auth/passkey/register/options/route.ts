import { passkey } from "@linkos/api";
import { route } from "@/lib/server";

// F-006 passkey registration (signed-in users)
export const POST = route(async ({ ctx }) => passkey.registrationOptions(ctx));
