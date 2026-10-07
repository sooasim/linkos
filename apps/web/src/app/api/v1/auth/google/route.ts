import { integration } from "@linkos/api";
import { NextResponse } from "next/server";
import { route, safeNext } from "@/lib/server";

export const GET = route(async ({ req }) => {
  const { url } = integration.googleAuthUrl("login", null);
  const res = NextResponse.redirect(url);
  res.cookies.set("lk_next", safeNext(req.nextUrl.searchParams.get("next")), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: (process.env.APP_ORIGIN ?? "").startsWith("https:") });
  return res;
}, { auth: false });
