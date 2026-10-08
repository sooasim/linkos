import { crm } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/lib/server";

const provider = (p: string) => z.enum(crm.CRM_PROVIDERS).parse(p);
export const GET = route<{ provider: string }>(async ({ req, ctx, params }) => {
  const p = provider(params.provider);
  const sp = req.nextUrl.searchParams;
  const origin = req.nextUrl.origin;
  if (sp.get("error")) return NextResponse.redirect(`${origin}/app/integrations?error=${p}_denied`);
  if (!ctx.userId) return NextResponse.redirect(`${origin}/login?next=/app/integrations`);
  await crm.completeCrmOAuth(p, ctx, sp.get("code") ?? "", sp.get("state") ?? "");
  return NextResponse.redirect(`${origin}/app/integrations?connected=${p}`);
}, { auth: false });
