import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// F-064 referral link: remember the code (no PII) for 7 days and continue to sign-up
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const res = NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  if (/^[A-Z0-9]{8}$/.test(code)) {
    res.cookies.set("lk_ref", code, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600, secure: (process.env.APP_ORIGIN ?? "").startsWith("https:") });
  }
  return res;
}
