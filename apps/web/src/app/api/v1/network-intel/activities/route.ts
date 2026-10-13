import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-109 네트워크 활동 기록(1:1 · 소개 · 추천사 · 그룹). 기록은 evidence 로도 남아 관계강도의 근거가 된다.
export const POST = route(async ({ ctx, body }) => netintel.recordActivity(ctx, parse(netintel.activityInput, body)), { status: 201 });
