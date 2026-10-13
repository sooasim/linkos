import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-011 Capability 어휘 등록
export const POST = route(async ({ ctx, body }) => netintel.upsertCapability(ctx, parse(netintel.capabilityInput, body)), { status: 201 });
