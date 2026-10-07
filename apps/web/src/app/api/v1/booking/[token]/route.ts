import { calendar } from "@linkos/api";
import { route } from "@/lib/server";

// F-107 public booking page data — no login (exchange-before-signup principle)
export const GET = route<{ token: string }>(async ({ params }) => calendar.publicBookingPage(params.token), { auth: false });
