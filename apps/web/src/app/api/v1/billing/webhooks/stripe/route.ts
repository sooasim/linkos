import { ApiError, billing, log } from "@linkos/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// F-193/F-194 Stripe webhook: raw body + Stripe-Signature verification, idempotent per event id.
// Not wrapped in route(): no session, no same-origin/JSON checks — the signature is the authentication.
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await billing.handleStripeWebhook(raw, req.headers.get("stripe-signature"));
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ code: e.code, message: e.message }, { status: e.status });
    log("error", "stripe.webhook_failed", { error: (e as Error).message });
    // 500 → Stripe retries; the event row was rolled back with the failed transaction
    return NextResponse.json({ code: "internal_error" }, { status: 500 });
  }
}
