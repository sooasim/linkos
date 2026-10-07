import { booth } from "@linkos/api";
import { parse, route } from "@/lib/server";

// event cost (ROI) + default audience variant (F-031)
export const PATCH = route<{ id: string }>(async ({ ctx, params, body }) => booth.updateEventSettings(ctx, params.id, parse(booth.eventSettingsInput, body)));
