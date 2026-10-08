import { crmHubspot, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

type P = { provider: string; dealId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ code: "not_found", message: "deal not found" }, { status: 404 });

// F-121 HubSpot Deal draft — read / edit (any edit → draft, re-approval required) / discard
export const GET = route<P>(async ({ ctx, params }) => (UUID.test(params.dealId) ? crmHubspot.getDeal(ctx.userId!, params.dealId) : notFound()));
export const PATCH = route<P>(async ({ ctx, params, body, req }) => {
  if (!UUID.test(params.dealId)) return notFound();
  const input = parse(crmHubspot.dealPatchInput, body);
  const r = await withIdempotency(`crm-deal:update:${ctx.userId}:${params.dealId}`, req.headers.get("idempotency-key"), body, async () => ({
    status: 200,
    body: await crmHubspot.updateDeal(ctx, params.dealId, input),
  }));
  return NextResponse.json(r.body, { status: r.status });
});
export const DELETE = route<P>(async ({ ctx, params }) => (UUID.test(params.dealId) ? crmHubspot.discardDeal(ctx, params.dealId) : notFound()));
