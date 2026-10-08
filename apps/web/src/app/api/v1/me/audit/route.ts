import { security } from "@linkos/api";
import { route } from "@/lib/server";

// F-137 / F-166 내 활동 기록 — ?before=<id>&limit=<n> keyset paging
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  return security.myAuditLog(ctx.userId!, { before: sp.get("before"), limit: Number(sp.get("limit")) || undefined });
});
