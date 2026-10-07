import { relationship } from "@linkos/api";
import { toVCard } from "@linkos/domain";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => {
  const c = await relationship.getContactRow(ctx.userId!, params.id);
  return new NextResponse(toVCard(c), { headers: { "content-type": "text/vcard; charset=utf-8", "content-disposition": `attachment; filename="contact.vcf"` } });
});
