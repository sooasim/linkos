import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-106 저장된 검색 + 알림
export const GET = route(async ({ ctx }) => netintel.listSavedSearches(ctx));
export const POST = route(async ({ ctx, body }) => netintel.saveSearch(ctx, parse(netintel.savedSearchInput, body)), { status: 201 });
