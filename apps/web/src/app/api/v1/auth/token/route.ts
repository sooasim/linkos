import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// Native clients (apps/mobile, App Clip): email OTP → bearer session token kept in the OS secure store.
// Same auth_sessions table as the web cookie; the token is bound to client_kind='native'.
const schema = z.object({ email: z.string().max(200), code: z.string().max(6), consents: identity.consentInput, displayName: z.string().max(80).optional() });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body);
  const r = await identity.verifyOtp(ctx, b.email, b.code, b.consents, b.displayName, "native");
  return NextResponse.json({ user: { id: r.user.id, email: r.user.email }, isNew: r.isNew, sessionToken: r.sessionToken }, { headers: { "cache-control": "no-store" } });
}, { auth: false });
