import { identity, integration } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext, setSession } from "@/lib/server";

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const origin = req.nextUrl.origin;
  if (sp.get("error")) return NextResponse.redirect(`${origin}/login?error=google_denied`);
  const state = integration.verifyState(sp.get("state") ?? "");
  const { tok, user } = await integration.exchangeGoogleCode(sp.get("code") ?? "");
  if (state.purpose !== "login") {
    if (!ctx.userId || ctx.userId !== state.userId) return NextResponse.redirect(`${origin}/login?next=/app/settings`);
    await integration.storeGoogleAccount(ctx.userId, tok);
    return NextResponse.redirect(`${origin}/app/settings?google=${state.purpose}`);
  }
  // Sign-in with Google: new users must accept terms on the consent screen first
  const consentAccepted = req.cookies.get("lk_consent")?.value === "1";
  const consents = consentAccepted ? (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true })) : [];
  try {
    // F-064: a NEW account that arrived through someone's /r/{code} link is attributed (lk_ref is SameSite=Lax — the
    // top-level GET redirect back from Google carries it)
    const ref = req.cookies.get("lk_ref")?.value ?? null;
    const result = await identity.signInWithGoogleOAuth(ctx, user, consents, ref);
    const res = NextResponse.redirect(`${origin}${safeNext(req.cookies.get("lk_next")?.value)}`);
    res.cookies.delete("lk_next");
    if (ref && result.isNew) res.cookies.delete("lk_ref");
    return setSession(res, result.sessionToken);
  } catch (e) {
    if ((e as { code?: string }).code === "consent_required") return NextResponse.redirect(`${origin}/login?consent=google`);
    // F-008 sso_required: this company account must use the company IdP → continue there (no PII in the URL)
    if ((e as { code?: string }).code === "sso_required") {
      const ssoUrl = (e as { details?: { ssoUrl?: string } }).details?.ssoUrl;
      if (ssoUrl) return NextResponse.redirect(`${origin}${ssoUrl}&next=${encodeURIComponent(safeNext(req.cookies.get("lk_next")?.value))}`);
    }
    throw e;
  }
}, { auth: false });
