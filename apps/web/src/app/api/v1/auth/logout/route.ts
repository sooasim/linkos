import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, bearerToken, route } from "@/lib/server";

export const POST = route(async ({ req }) => {
  const bearer = bearerToken(req);
  if (bearer) {
    await identity.logout(bearer); // native app sign-out
    return NextResponse.json({ ok: true });
  }
  await identity.logout(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}, { auth: false });
