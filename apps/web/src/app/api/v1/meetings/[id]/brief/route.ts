import { meeting } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => meeting.getMeetingBrief(ctx, params.id));
