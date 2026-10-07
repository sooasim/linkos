import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, route } from "@/lib/server";

export const POST = route(async ({ req }) => {
  await identity.logout(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}, { auth: false });
