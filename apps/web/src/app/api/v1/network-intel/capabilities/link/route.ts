import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-011 연락처 ↔ Capability/Need 연결. kind 로 제공/필요를 구분한다(섞지 않는다).
export const POST = route(async ({ ctx, body }) => netintel.linkCapability(ctx, parse(netintel.linkCapabilityInput, body)));
