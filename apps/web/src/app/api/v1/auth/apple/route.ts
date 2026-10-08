import { apple } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext } from "@/lib/server";

// F-001/F-060 Sign in with Apple — start: one-time state + nonce → Apple authorize (response_mode=form_post).
// The consent decision made on /login (lk_consent cookie) travels inside the server-side state row, because Apple's
// callback is a cross-site POST that does not carry SameSite=Lax cookies.
export const GET = route(async ({ ctx, req }) => {
  const origin = req.nextUrl.origin;
  if (!apple.appleEnabled()) return NextResponse.redirect(`${origin}/login?error=apple_not_configured`);
  const consentAccepted = req.cookies.get("lk_consent")?.value === "1";
  const { url } = await apple.appleAuthStart(ctx, { next: safeNext(req.nextUrl.searchParams.get("next")), consentAccepted });
  const res = NextResponse.redirect(url);
  res.cookies.delete("lk_consent");
  return res;
}, { auth: false });
