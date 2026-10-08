import { security } from "@linkos/api";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, route } from "@/lib/server";

export const POST = route(async ({ ctx }) => {
  const r = await security.requestDeletion(ctx);
  const res = NextResponse.json(r, { status: 202 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
