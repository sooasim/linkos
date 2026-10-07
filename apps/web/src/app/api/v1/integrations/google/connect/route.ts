import { integration } from "@linkos/api";
import { route } from "@/lib/server";

// connectGoogle — returns the OAuth URL (contacts scope; minimal scopes)
export const POST = route(async ({ ctx }) => ({ url: integration.googleAuthUrl("contacts", ctx.userId).url }));
