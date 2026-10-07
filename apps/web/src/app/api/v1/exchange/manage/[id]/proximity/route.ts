import { channels } from "@linkos/api";
import { route } from "@/lib/server";

// F-039 앱 근접 교환 (native apps): POST issues a short-lived ephemeral BLE id bound to this session;
// GET lists pending proximity matches (receiver name + the shared 4-digit code) for the sender to confirm.
export const POST = route<{ id: string }>(async ({ ctx, params }) => channels.issueProximityId(ctx, params.id), { status: 201 });
export const GET = route<{ id: string }>(async ({ ctx, params }) => channels.listProximityMatches(ctx, params.id));
