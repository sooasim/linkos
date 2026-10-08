import { org } from "@linkos/api";
import { parse, route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => org.getOrg(ctx, params.id));
// F-138 branding, F-004 domain join mode, rename (admin+)
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => org.updateOrg(ctx, params.id, parse(org.orgUpdateInput, body)));
// owner only; company leads fall back to their current 담당자 as personal contacts
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => org.deleteOrg(ctx, params.id));
