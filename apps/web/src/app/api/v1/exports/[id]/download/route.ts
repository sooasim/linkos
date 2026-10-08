import { integration } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const f = await integration.renderExport(ctx, params.id);
  return new NextResponse(f.body as BodyInit, { headers: { "content-type": f.contentType, "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
