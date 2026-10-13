import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-015 자연어 Intent + N-016 설명 가능한 추천. 응답은 evaluateDisclosure/applyDisclosure 를 통과한 payload 다.
export const POST = route(async ({ ctx, body }) => netintel.search(ctx, parse(netintel.searchInput, body)));
