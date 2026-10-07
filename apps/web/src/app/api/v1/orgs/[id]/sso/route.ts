import { enterprise } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-008 per-org OIDC SSO configuration (client secret sealed with AES-GCM, never returned)
export const GET = route<{ id: string }>(async ({ ctx, params }) => enterprise.getSsoConfig(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => enterprise.saveSsoConfig(ctx, params.id, parse(enterprise.ssoConfigInput, body)));
