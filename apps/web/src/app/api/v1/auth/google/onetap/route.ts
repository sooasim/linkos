import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, setSession } from "@/lib/server";

// F-060 One Tap 가입: Google Identity Services credential (ID token) → verified against Google JWKS → session cookie.
// New users get 422 consent_required first; the client shows the consent step and re-posts the same credential.
const schema = z.object({ credential: z.string().min(20).max(4096), consents: identity.consentInput });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body);
  const r = await identity.signInWithGoogleIdToken(ctx, b.credential, b.consents);
  return setSession(NextResponse.json({ user: { id: r.user.id, email: r.user.email }, isNew: r.isNew }), r.sessionToken);
}, { auth: false });
