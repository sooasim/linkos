import { booth } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-147 CSV export (audited)
export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const f = await booth.exportLeadsCsv(ctx, params.id);
  return new NextResponse(f.body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
