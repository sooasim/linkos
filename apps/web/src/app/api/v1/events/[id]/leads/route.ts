import { booth } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-147 booth lead flow
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => ({
  leads: await booth.listLeads(ctx, params.id, { mine: req.nextUrl.searchParams.get("mine") === "1", grade: req.nextUrl.searchParams.get("grade") ?? undefined }),
}));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => booth.captureLead(ctx, params.id, parse(booth.leadInput, body)), { status: 201 });
