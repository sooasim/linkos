import { identity } from "@linkos/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route, setSession } from "@/lib/server";

// Test server only (DEMO_LOGIN=1): one-click throwaway account. 404 everywhere else.
const schema = z.object({ consents: identity.consentInput });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body ?? {});
  const r = await identity.demoLogin(ctx, b.consents);
  return setSession(NextResponse.json({ user: { id: r.user.id }, isNew: true }), r.sessionToken);
}, { auth: false });
