import { org } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";
import { withIdempotency } from "@linkos/api";

// F-129 조직/워크스페이스: my orgs (+ verified-domain orgs I can join), create org
export const GET = route(async ({ ctx }) => org.listMyOrgs(ctx.userId!));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(org.orgCreateInput, body);
  const r = await withIdempotency(`org:create:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await org.createOrg(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
