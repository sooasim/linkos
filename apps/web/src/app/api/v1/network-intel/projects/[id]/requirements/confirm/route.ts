import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-018 초안 검토 확정. 선택하지 않은 초안은 사용자가 거부한 것으로 보고 삭제한다.
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => netintel.confirmRequirements(ctx, params.id, parse(netintel.confirmRequirementsInput, body)));
