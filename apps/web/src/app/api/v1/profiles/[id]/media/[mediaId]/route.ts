import { files } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; mediaId: string }>(async ({ ctx, params }) => files.deleteProfileMedia(ctx, params.id, params.mediaId));
