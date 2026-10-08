import { growth } from "@linkos/api";
import { NextResponse } from "next/server";
import { anonId, route, withAnon } from "@/lib/server";

// F-181 client helper source: evaluated client-visible flags for the viewer (signed in or anonymous)
export const GET = route(async ({ ctx, req }) => {
  const a = anonId(req);
  const flags = await growth.flagsFor({ userId: ctx.userId, anonId: a.id });
  return withAnon(NextResponse.json({ flags }, { headers: { "cache-control": "private, max-age=30" } }), a);
}, { auth: false });
