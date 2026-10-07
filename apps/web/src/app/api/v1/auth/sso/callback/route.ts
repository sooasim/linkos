import { enterprise } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext, setSession } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  const origin = req.nextUrl.origin;
  if (sp.get("error")) return NextResponse.redirect(`${origin}/login?error=sso_denied`);
  // new accounts accept terms on the consent screen first (same flow as Google sign-in)
  const accepted = req.cookies.get("lk_consent")?.value === "1";
  const consents = accepted ? (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true })) : [];
  try {
    const r = await enterprise.ssoCallback(ctx, { code: sp.get("code") ?? "", state: sp.get("state") ?? "", consents });
    return setSession(NextResponse.redirect(`${origin}${safeNext(r.next, "/app")}`), r.sessionToken);
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === "consent_required") return NextResponse.redirect(`${origin}/login?consent=sso`);
    if (c && c.startsWith("sso_")) return NextResponse.redirect(`${origin}/login?error=${c}`);
    throw e;
  }
}, { auth: false });
