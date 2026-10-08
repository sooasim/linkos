import { identity, referral } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, setSession } from "@/lib/server";

const schema = z.object({ email: z.string().max(200), code: z.string().max(6), consents: identity.consentInput, displayName: z.string().max(80).optional() });

export const POST = route(async ({ ctx, body, req }) => {
  const b = parse(schema, body);
  const r = await identity.verifyOtp(ctx, b.email, b.code, b.consents, b.displayName);
  // F-064: a NEW account that arrived through someone's /r/{code} link is attributed (user ids only)
  const ref = req.cookies.get("lk_ref")?.value;
  if (r.isNew && ref) await referral.attributeSignupByCode(r.user.id, ref).catch(() => undefined);
  const res = setSession(NextResponse.json({ user: { id: r.user.id, email: r.user.email }, isNew: r.isNew }), r.sessionToken);
  if (ref) res.cookies.delete("lk_ref");
  return res;
}, { auth: false });
