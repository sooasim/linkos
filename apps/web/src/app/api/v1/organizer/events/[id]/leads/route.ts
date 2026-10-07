import { booth } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-151 organizer API — booth leads export (json | csv), audited per call
export const GET = route<{ id: string }>(async ({ req, params }) => {
  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const r = await booth.organizerLeads(req.headers.get("authorization"), params.id, format);
  if ("csv" in r) return new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}, { auth: false });
