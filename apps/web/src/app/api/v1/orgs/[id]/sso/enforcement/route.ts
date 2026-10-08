import { saml } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-008 org policy sso_required (admin-only, audited). Enabling revokes non-SSO sessions of verified-domain users;
// org owners keep e-mail OTP as break-glass.
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => saml.setSsoRequired(ctx, params.id, parse(saml.ssoEnforcementInput, body)));
