import { capture } from "@linkos/api";
import { route } from "@/lib/server";

export const GET = route<{ id: string }>(async ({ ctx, params }) => capture.getCaptureJob(ctx, params.id));
