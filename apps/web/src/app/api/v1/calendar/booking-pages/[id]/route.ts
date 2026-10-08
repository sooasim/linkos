import { calendar } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const patch = calendar.bookingPageInput.partial().extend({ rotateLink: z.boolean().optional() });
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => calendar.updateBookingPage(ctx, params.id, parse(patch, body)));
