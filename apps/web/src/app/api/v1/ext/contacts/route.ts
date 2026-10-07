import { enterprise } from "@linkos/api";
import { route } from "@/lib/server";

// F-140 server-to-server read: org team address book (Authorization: Bearer lk_…, scope contacts:read)
export const GET = route(async ({ req }) => {
  const auth = await enterprise.authenticateApiKey(req.headers.get("authorization"), "contacts:read");
  const sp = req.nextUrl.searchParams;
  return { contacts: await enterprise.apiListContacts(auth, { kind: "contacts", limit: Number(sp.get("limit") ?? 100) || 100, updatedSince: sp.get("updated_since") }) };
}, { auth: false });
