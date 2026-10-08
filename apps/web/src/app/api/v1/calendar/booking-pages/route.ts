import { calendar, withIdempotency } from "@linkos/api";
import { NextResponse } from "next/server";
import { parse, route } from "@/lib/server";

// F-107 캘린더 예약 — owner's booking links
export const GET = route(async ({ ctx }) => ({ pages: await calendar.listBookingPages(ctx.userId!) }));
export const POST = route(async ({ ctx, body, req }) => {
  const input = parse(calendar.bookingPageInput, body);
  const r = await withIdempotency(`booking-page:${ctx.userId}`, req.headers.get("idempotency-key"), body, async () => ({ status: 201, body: await calendar.createBookingPage(ctx, input) }));
  return NextResponse.json(r.body, { status: r.status });
});
