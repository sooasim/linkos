import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// 사용자가 직접 추가한 요구사항은 바로 확정 상태다
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => netintel.addRequirement(ctx, params.id, parse(netintel.requirementInput, body)), { status: 201 });
