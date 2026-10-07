import { generateToken } from "@linkos/domain";
import { handoff } from "@linkos/api";
import { NextResponse } from "next/server";
import { ANON_COOKIE, route } from "@/lib/server";

// getExchangeSession — public-safe sender card, no login wall (F-053)
export const GET = route<{ token: string }>(async ({ req, ctx, params }) => {
  const anon = req.cookies.get(ANON_COOKIE)?.value ?? generateToken(16);
  const landing = await handoff.openGuestLanding(params.token, ctx, anon);
  const res = NextResponse.json(landing, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (!req.cookies.get(ANON_COOKIE)) res.cookies.set(ANON_COOKIE, anon, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: (process.env.APP_ORIGIN ?? "").startsWith("https:") });
  return res;
}, { auth: false });
