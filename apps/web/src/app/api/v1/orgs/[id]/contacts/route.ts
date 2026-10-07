import { org } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-131 team address book (tenant-scoped; PII masked for viewers)
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const sp = req.nextUrl.searchParams;
  const own = sp.get("ownership");
  return {
    contacts: await org.listTeamContacts(ctx, params.id, {
      query: sp.get("q") ?? undefined,
      ownership: own === "company" || own === "personal" ? own : undefined,
      ownerId: sp.get("owner") ?? undefined,
      limit: Number(sp.get("limit") ?? 100) || 100,
    }),
  };
});
// share my contacts into the org (optionally as company-owned leads)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => org.shareContacts(ctx, params.id, parse(org.shareInput, body)));
