import { saml } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-008 per-org SAML 2.0 IdP configuration (entityID, SSO URL, signing cert(s) for rotation, NameID, attribute mapping)
export const GET = route<{ id: string }>(async ({ ctx, params }) => saml.getSamlConfig(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => saml.saveSamlConfig(ctx, params.id, parse(saml.samlConfigInput, body)));
