import { enterprise } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext } from "@/lib/server";

// F-008 B2B SSO: ?org=<slug> or ?email=<work email> → redirect to the org's OIDC IdP
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  try {
    const { url } = await enterprise.ssoStart(ctx, { org: sp.get("org"), email: sp.get("email"), next: safeNext(sp.get("next")) });
    return NextResponse.redirect(url);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return NextResponse.redirect(`${req.nextUrl.origin}/login?error=sso_not_found`);
    throw e;
  }
}, { auth: false });
