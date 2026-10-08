import { enterprise, relationship } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-140 company-owned leads (scope leads:read / leads:write)
export const GET = route(async ({ req }) => {
  const auth = await enterprise.authenticateApiKey(req.headers.get("authorization"), "leads:read");
  const sp = req.nextUrl.searchParams;
  return { leads: await enterprise.apiListContacts(auth, { kind: "leads", limit: Number(sp.get("limit") ?? 100) || 100, updatedSince: sp.get("updated_since") }) };
}, { auth: false });
export const POST = route(async ({ req, body }) => {
  const auth = await enterprise.authenticateApiKey(req.headers.get("authorization"), "leads:write");
  return enterprise.apiCreateLead(auth, parse(relationship.contactInput, body));
}, { auth: false, status: 201 });
