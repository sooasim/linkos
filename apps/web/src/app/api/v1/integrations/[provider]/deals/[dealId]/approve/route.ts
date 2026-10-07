import { crmHubspot, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-121 HubSpot Deal — explicit user approval of the exact draft version → one idempotent sync job (create or guarded update)
export const POST = route<{ provider: string; dealId: string }>(async ({ ctx, params, body, req }) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.dealId)) return NextResponse.json({ code: "not_found", message: "deal not found" }, { status: 404 });
  const input = parse(crmHubspot.approveInput, body);
  const r = await withIdempotency(`crm-deal:approve:${ctx.userId}:${params.dealId}`, req.headers.get("idempotency-key"), body, async () => ({
    status: 200,
    body: await crmHubspot.approveDeal(ctx, params.dealId, input),
  }));
  return NextResponse.json(r.body, { status: r.status });
});
