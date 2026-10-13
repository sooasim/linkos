import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-110 교차 소개 가능성 기반 파트너 탐색 (업종 일치가 아니라 양방향 소개 가능성)
export const GET = route(async ({ ctx, req }) => netintel.referralPartners(ctx, Number(req.nextUrl.searchParams.get("limit") ?? 20)));
