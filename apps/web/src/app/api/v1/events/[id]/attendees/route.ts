import { event } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-142 참가자 등록 — organizer (event owner) session API: CSV/paste upsert (idempotent by registrant key) + list
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ attendees: await event.listAttendees(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => event.importAttendees(ctx, params.id, parse(event.attendeeImportInput, body)), { status: 201 });
