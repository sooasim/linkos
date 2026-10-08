import { event } from "@linkos/api";
import { route } from "@/lib/server";

// F-142 remove a pre-registered (not yet joined) attendee — owner only
export const DELETE = route<{ id: string; attendeeId: string }>(async ({ ctx, params }) => event.removeRegistrant(ctx, params.id, params.attendeeId));
