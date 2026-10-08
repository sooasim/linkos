import { relationship, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  return { contacts: await relationship.listContacts(ctx.userId!, { query: sp.get("q") ?? undefined, tag: sp.get("tag") ?? undefined, limit: Number(sp.get("limit") ?? 100) || 100 }) };
});

export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(relationship.contactInput, body);
  const r = await withIdempotency(`contact:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await relationship.createContact(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
