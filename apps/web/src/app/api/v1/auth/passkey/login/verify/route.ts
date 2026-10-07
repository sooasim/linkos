import { passkey } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route, setSession } from "@/lib/server";

export const POST = route(async ({ ctx, body }) => {
  const r = await passkey.verifyAuthentication(ctx, parse(passkey.loginVerifyInput, body));
  return setSession(NextResponse.json({ userId: r.userId }), r.sessionToken);
}, { auth: false });
