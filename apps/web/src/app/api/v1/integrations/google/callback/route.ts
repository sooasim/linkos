import { identity, integration, tx } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext, setSession } from "@/lib/server";

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const origin = req.nextUrl.origin;
  if (sp.get("error")) return NextResponse.redirect(`${origin}/login?error=google_denied`);
  const state = integration.verifyState(sp.get("state") ?? "");
  const { tok, user } = await integration.exchangeGoogleCode(sp.get("code") ?? "");
  if (state.purpose === "contacts") {
    if (!ctx.userId || ctx.userId !== state.userId) return NextResponse.redirect(`${origin}/login?next=/app/settings`);
    await integration.storeGoogleAccount(ctx.userId, tok);
    return NextResponse.redirect(`${origin}/app/settings?google=connected`);
  }
  // Sign-in with Google: new users must accept terms on the consent screen first
  const consentAccepted = req.cookies.get("lk_consent")?.value === "1";
  const consents = consentAccepted ? (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true })) : [];
  try {
    const result = await tx(async (c) => {
      const { user: u, isNew } = await identity.upsertUserByEmail(c, user.email.toLowerCase(), consents, user.name, "google", user.sub);
      const token = await identity.createSession(c, u.id, ctx);
      return { token, isNew };
    });
    const res = NextResponse.redirect(`${origin}${safeNext(req.cookies.get("lk_next")?.value)}`);
    res.cookies.delete("lk_next");
    return setSession(res, result.token);
  } catch (e) {
    if ((e as { code?: string }).code === "consent_required") return NextResponse.redirect(`${origin}/login?consent=google`);
    throw e;
  }
}, { auth: false });
