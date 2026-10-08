import { booth } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-151 organizer API — Authorization: Bearer lkev_… ; opted-in attendees, public card fields only
export const GET = route<{ id: string }>(async ({ req, params }) => {
  const sp = req.nextUrl.searchParams;
  const r = await booth.organizerAttendees(req.headers.get("authorization"), params.id, { limit: Number(sp.get("limit") ?? 100) || 100, after: sp.get("after") ?? undefined });
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}, { auth: false });
