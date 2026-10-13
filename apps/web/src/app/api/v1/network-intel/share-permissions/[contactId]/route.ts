import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-022 공개 권한 — 탐색/신원/연락처는 서로 다른 권한이다 (S13 Privacy Center)
export const GET = route<{ contactId: string }>(async ({ ctx, params }) => netintel.getSharePermission(ctx, params.contactId));
export const PUT = route<{ contactId: string }>(async ({ ctx, params, body }) => netintel.setSharePermission(ctx, params.contactId, parse(netintel.sharePermissionInput, body)));
