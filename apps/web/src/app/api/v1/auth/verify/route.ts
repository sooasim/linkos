import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, setSession } from "@/lib/server";

const schema = z.object({ email: z.string().max(200), code: z.string().max(6), consents: identity.consentInput, displayName: z.string().max(80).optional() });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body);
  const r = await identity.verifyOtp(ctx, b.email, b.code, b.consents, b.displayName);
  return setSession(NextResponse.json({ user: { id: r.user.id, email: r.user.email }, isNew: r.isNew }), r.sessionToken);
}, { auth: false });
