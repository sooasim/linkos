import { growth } from "@linkos/api";
import { NextResponse } from "next/server";
import { anonId, parse, route, withAnon } from "@/lib/server";

// F-188 first-party client events (allowlisted names, PII-free props)
export const POST = route(async ({ ctx, req, body }) => {
  const a = anonId(req);
  await growth.trackClient(ctx, ctx.userId ? null : a.id, parse(growth.clientEventInput, body));
  return withAnon(NextResponse.json({ ok: true }, { status: 202 }), a);
}, { auth: false });
