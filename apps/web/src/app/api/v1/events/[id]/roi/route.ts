import { booth } from "@linkos/api";
import { route } from "@/lib/server";

// F-149 Event ROI
export const GET = route<{ id: string }>(async ({ ctx, params }) => booth.eventRoiReport(ctx, params.id));
