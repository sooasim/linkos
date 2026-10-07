import { enterprise } from "@linkos/api";
import { generateToken } from "@linkos/domain";
import { NextResponse } from "next/server";
import { SAML_BINDING_COOKIE, route, safeNext } from "@/lib/server";

// F-008 B2B SSO: ?org=<slug> or ?email=<work email> → redirect to the org's IdP (OIDC, or SAML 2.0 HTTP-Redirect)
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  // the SAML ACS is a cross-site POST: only a SameSite=None (Secure) cookie reaches it, so the binding is https-only
  const binding = (process.env.APP_ORIGIN ?? "").startsWith("https:") ? generateToken(24) : null;
  try {
    const { url } = await enterprise.ssoStart(ctx, {
      org: sp.get("org"),
      email: sp.get("email"),
      next: safeNext(sp.get("next")),
      // new accounts accept terms on the consent screen first; recorded with the request (the ACS POST carries no Lax cookies)
      consent: req.cookies.get("lk_consent")?.value === "1",
      browserBinding: binding,
    });
    const res = NextResponse.redirect(url);
    if (binding) res.cookies.set(SAML_BINDING_COOKIE, binding, { httpOnly: true, secure: true, sameSite: "none", path: "/api/v1/sso/saml", maxAge: 600 });
    return res;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return NextResponse.redirect(`${req.nextUrl.origin}/login?error=sso_not_found`);
    throw e;
  }
}, { auth: false });
