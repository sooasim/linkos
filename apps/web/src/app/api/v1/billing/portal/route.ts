import { billing } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

// F-194 Customer Portal (upgrade/downgrade/cancel/payment method)
export const POST = route(async ({ ctx, body }) => billing.createPortal(ctx, parse(z.object({ organizationId: z.string().uuid().optional() }), body).organizationId));
