import { security } from "@linkos/api";
import { route } from "@/lib/server";

// exportMyData job status: queued | processing | done (downloadUrl: signed, 5 min) | failed | expired. Requester only.
export const GET = route<{ id: string }>(async ({ ctx, params }) => security.getPrivacyExport(ctx, params.id));
