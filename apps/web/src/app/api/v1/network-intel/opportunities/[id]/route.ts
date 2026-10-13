import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// 단계 전이. 허용되지 않은 전이는 409 다. 전이는 학습 라벨로도 기록된다.
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => netintel.advanceOpportunity(ctx, params.id, parse(netintel.advanceOpportunityInput, body)));
