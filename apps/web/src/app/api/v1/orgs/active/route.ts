import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-129 workspace switch (null = personal)
export const POST = route(async ({ ctx, body }) => org.setActiveOrg(ctx, parse(z.object({ orgId: z.string().uuid().nullable() }), body).orgId));
