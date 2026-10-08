import { crmHubspot, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-121 HubSpot Company sync — company upsert (dedupe by domain) + contact↔company association, one version-keyed job per contact
export const POST = route<{ provider: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(crmHubspot.companySyncInput, body);
  const r = await withIdempotency(`crm-companies:${ctx.userId}:${params.provider}`, req.headers.get("idempotency-key"), body, async () => ({
    status: 200,
    body: await crmHubspot.syncCompanies(ctx, params.provider, input),
  }));
  return NextResponse.json(r.body, { status: r.status });
});
