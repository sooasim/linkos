import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-004 verified email domain (proof: the admin's own verified login email is on the domain)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => org.addDomain(ctx, params.id, parse(z.object({ domain: z.string().max(200) }), body).domain), { status: 201 });
export const DELETE = route<{ id: string }>(async ({ ctx, params, req }) => org.removeDomain(ctx, params.id, req.nextUrl.searchParams.get("domain") ?? ""));
