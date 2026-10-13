import { netintel } from "@linkos/api";
import { ApiError } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-108 Evidence Drawer: 추천 이유의 원천·날짜·confidence·추론여부
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  const entityType = sp.get("entityType");
  const entityId = sp.get("entityId");
  if (!entityType || !entityId) throw new ApiError(400, "entity_required", "entityType 과 entityId 가 필요합니다.");
  return netintel.listEvidence(ctx, entityType, entityId);
});
export const POST = route(async ({ ctx, body }) => netintel.recordEvidence(ctx, parse(netintel.evidenceInput, body)), { status: 201 });
