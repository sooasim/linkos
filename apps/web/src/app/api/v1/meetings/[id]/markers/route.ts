import { meeting } from "@linkos/api";
import { parse, route } from "@/lib/server";

// UX-015 녹음 마커 — timestamp bookmarks (offset from the recording start, optional label)
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ markers: await meeting.listMarkers(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => meeting.addMarker(ctx, params.id, parse(meeting.markerInput, body)), { status: 201 });
