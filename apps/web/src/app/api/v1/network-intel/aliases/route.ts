import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-107 분류 별칭 — 사전에 없는 사내 표현을 canonical 값으로 흡수한다
export const GET = route(async ({ ctx }) => netintel.listAliases(ctx));
export const POST = route(async ({ ctx, body }) => netintel.addAlias(ctx, parse(netintel.aliasInput, body)), { status: 201 });
