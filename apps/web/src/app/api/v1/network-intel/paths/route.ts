import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-105 Top-K 소개 경로. 단일 최단경로가 아니라 대안 경로를 함께 돌려준다.
export const POST = route(async ({ ctx, body }) => netintel.introPaths(ctx, parse(netintel.pathsInput, body)));
