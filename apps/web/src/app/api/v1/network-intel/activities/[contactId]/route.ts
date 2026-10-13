import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-109 연락처별 활동 이력
export const GET = route<{ contactId: string }>(async ({ ctx, params }) => netintel.listActivities(ctx, params.contactId));
