import { cardViews } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// X-003 CTA tap / vCard save counters from the guest landing and /p pages. No viewer id is stored;
// GPC / DNT from the browser and the owner's analytics opt-out suppress counting.
export const POST = route(async ({ ctx, req, body }) => {
  const r = await cardViews.recordClientSignal(ctx, parse(cardViews.clientSignalInput, body), { gpc: req.headers.get("sec-gpc"), dnt: req.headers.get("dnt") });
  return NextResponse.json(r, { status: 202 });
}, { auth: false });
