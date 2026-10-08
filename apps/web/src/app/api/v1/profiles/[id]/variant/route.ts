import { living } from "@linkos/api";
import { route } from "@/lib/server";

// F-031 which audience variant a recipient would see (owner preview)
export const GET = route<{ id: string }>(async ({ ctx, params, req }) => {
  const sp = req.nextUrl.searchParams;
  return living.previewVariant(ctx, params.id, { explicit: sp.get("audience"), eventId: sp.get("eventId"), contactId: sp.get("contactId") });
});
