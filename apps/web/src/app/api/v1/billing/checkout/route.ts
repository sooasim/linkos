import { billing } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-193 Stripe Checkout (subscription). Idempotency-Key is forwarded to Stripe.
export const POST = route(async ({ ctx, body, req }) => billing.createCheckout(ctx, parse(billing.checkoutInput, body), req.headers.get("idempotency-key")), { status: 201 });
