import { growth } from "@linkos/api";
import { NextResponse } from "next/server";
import { anonId, route, withAnon } from "@/lib/server";

// F-196 deterministic assignment + exposure (works for anonymous guests)
export const GET = route<{ key: string }>(async ({ ctx, req, params }) => {
  const a = anonId(req);
  const r = await growth.assignment(params.key, ctx.userId ? { userId: ctx.userId } : { anonId: a.id });
  return withAnon(NextResponse.json(r, { headers: { "cache-control": "no-store" } }), a);
}, { auth: false });
