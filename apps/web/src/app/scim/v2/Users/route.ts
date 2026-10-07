import { enterprise } from "@linkos/api";
import { scim } from "@/lib/scim";

// F-008 SCIM 2.0 Users (per-org bearer token)
export const GET = scim(async ({ orgId, req }) => {
  const sp = req.nextUrl.searchParams;
  return { body: await enterprise.scimList(orgId, { filter: sp.get("filter"), startIndex: Number(sp.get("startIndex") ?? 1) || 1, count: Number(sp.get("count") ?? 100) || 100 }) };
});
export const POST = scim(async ({ orgId, body }) => ({ status: 201, body: await enterprise.scimCreate(orgId, body) }));
