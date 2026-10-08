import { crmHubspot, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-121 HubSpot Deal — drafts only (CLAUDE.md rule 8). Sending to HubSpot happens solely via …/deals/{id}/approve.
export const GET = route<{ provider: string }>(async ({ ctx, req }) =>
  crmHubspot.listDeals(ctx.userId!, crmHubspot.dealListQuery.parse({ meetingId: req.nextUrl.searchParams.get("meetingId") ?? undefined })),
);
export const POST = route<{ provider: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(crmHubspot.dealDraftInput, body);
  const r = await withIdempotency(`crm-deal:create:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({
    status: 201,
    body: await crmHubspot.createDealDraft(ctx, params.provider, input),
  }));
  return NextResponse.json(r.body, { status: r.status });
});
