import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-110 Ideal Customer Profile
export const GET = route(async ({ ctx }) => netintel.getIcp(ctx));
export const PUT = route(async ({ ctx, body }) => netintel.setIcp(ctx, parse(netintel.icpInput, body)));
