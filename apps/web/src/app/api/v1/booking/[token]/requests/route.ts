import { calendar } from "@linkos/api";
import { parse, route } from "@/lib/server";

// Guest picks a slot → pending owner approval (F-108). Rate limited per IP and per page.
export const POST = route<{ token: string }>(async ({ ctx, params, body }) => calendar.requestBooking(params.token, parse(calendar.bookingRequestInput, body), ctx.ip), { auth: false, status: 201 });
