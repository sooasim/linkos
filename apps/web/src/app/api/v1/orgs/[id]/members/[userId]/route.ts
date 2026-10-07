import { ORG_ROLES } from "@linkos/domain";
import { org } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-130 role change (owner/admin rules enforced in the service)
export const PATCH = route<{ id: string; userId: string }>(async ({ ctx, params, body }) => org.changeRole(ctx, params.id, params.userId, parse(z.object({ role: z.enum(ORG_ROLES) }), body).role));
// remove member / leave (self). F-132: ?reassignTo= receives their company leads
export const DELETE = route<{ id: string; userId: string }>(async ({ ctx, params, req }) => {
  const to = req.nextUrl.searchParams.get("reassignTo");
  return org.removeMember(ctx, params.id, params.userId, to && /^[0-9a-f-]{36}$/i.test(to) ? to : null);
});
