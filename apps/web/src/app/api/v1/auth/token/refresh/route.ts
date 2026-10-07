import { ApiError, identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { bearerToken, route } from "@/lib/server";

// Explicit refresh-token rotation for native clients (F-007). The old bearer token stops working immediately.
export const POST = route(async ({ req }) => {
  const token = bearerToken(req);
  if (!token) throw new ApiError(401, "unauthorized", "로그인이 필요합니다.");
  const r = await identity.refreshNativeSession(token, { userAgent: req.headers.get("user-agent") ?? "" });
  return NextResponse.json({ sessionToken: r.sessionToken }, { headers: { "cache-control": "no-store" } });
}, { auth: false });
