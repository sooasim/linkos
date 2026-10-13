import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-021 기회 파이프라인 (S12 Opportunity Board)
export const GET = route(async ({ ctx, req }) => netintel.listOpportunities(ctx, { projectId: req.nextUrl.searchParams.get("projectId") }));
export const POST = route(async ({ ctx, body }) => netintel.createOpportunity(ctx, parse(netintel.opportunityInput, body)), { status: 201 });
