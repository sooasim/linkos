import { saml } from "@linkos/api";
import { type NextRequest, NextResponse } from "next/server";
import { SAML_BINDING_COOKIE, errorResponse, requestCtx, safeNext, setSession } from "@/lib/server";

// F-008 SAML Assertion Consumer Service (HTTP-POST binding). The IdP's auto-submitted form is a cross-site POST of
// application/x-www-form-urlencoded, so this handler does not use route() (same-origin + JSON-only for app APIs).
// Its CSRF/replay protection is the signed one-time RelayState + stored AuthnRequest ID (+ browser-binding cookie).
export async function POST(req: NextRequest, context: { params: Promise<{ orgId: string }> }): Promise<NextResponse> {
  const ctx = requestCtx(req);
  const origin = req.nextUrl.origin;
  const { orgId } = await context.params;
  const to = (path: string) => NextResponse.redirect(`${origin}${path}`, 303);
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded") && !ct.includes("multipart/form-data")) return to("/login?error=saml_invalid_response");
  const form = await req.formData().catch(() => null);
  const field = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v : null;
  };
  try {
    const r = await saml.samlAcs(ctx, { orgId, samlResponse: field("SAMLResponse"), relayState: field("RelayState"), browserBinding: req.cookies.get(SAML_BINDING_COOKIE)?.value ?? null });
    const res = setSession(to(safeNext(r.next, "/app")), r.sessionToken);
    if (req.cookies.has(SAML_BINDING_COOKIE)) res.cookies.set(SAML_BINDING_COOKIE, "", { httpOnly: true, secure: true, sameSite: "none", path: "/api/v1/sso/saml", maxAge: 0 });
    return res;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === "consent_required") return to("/login?consent=sso");
    if (c && (c.startsWith("sso_") || c.startsWith("saml_") || c === "invalid_state")) return to(`/login?error=${c}`);
    if ((e as { status?: number }).status === 404) return to("/login?error=sso_not_found");
    return errorResponse(e, ctx.requestId);
  }
}
