import { netintel } from "@linkos/api";
import { ApiError } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-008 Person↔Company 소속 이력 (Person 360 의 Companies 탭)
export const GET = route(async ({ ctx, req }) => {
  const contactId = req.nextUrl.searchParams.get("contactId");
  if (!contactId) throw new ApiError(400, "contact_required", "contactId 가 필요합니다.");
  return netintel.listRoles(ctx, contactId);
});
export const POST = route(async ({ ctx, body }) => netintel.addRole(ctx, parse(netintel.roleInput, body)), { status: 201 });
