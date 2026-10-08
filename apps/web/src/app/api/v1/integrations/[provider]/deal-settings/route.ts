import { crmHubspot, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-121 HubSpot Company/Deal · F-127 필드 매핑 — company/deal property mapping + deal pipeline/stage mapping
export const GET = route<{ provider: string }>(async ({ ctx, params }) => {
  if (params.provider !== "hubspot") return NextResponse.json({ code: "deals_unsupported", message: "회사·딜 동기화는 현재 HubSpot만 지원합니다." }, { status: 422 });
  return crmHubspot.getHubspotSettings(ctx.userId!);
});
export const PUT = route<{ provider: string }>(async ({ ctx, params, body, req }) => {
  const input = parse(crmHubspot.settingsInput, body);
  const r = await withIdempotency(`crm-settings:${ctx.userId}:${params.provider}:${input.object}`, req.headers.get("idempotency-key"), body, async () => ({
    status: 200,
    body: await crmHubspot.saveHubspotSettings(ctx, params.provider, input),
  }));
  return NextResponse.json(r.body, { status: r.status });
});
