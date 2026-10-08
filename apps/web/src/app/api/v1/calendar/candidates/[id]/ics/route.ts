import { calendar } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// ICS fallback for every candidate/event
export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const f = await calendar.candidateIcs(ctx.userId!, params.id);
  return new NextResponse(f.body, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
