import { files } from "@linkos/api";
import { route } from "@/lib/server";

// F-019: original card images linked to this contact (owner only)
export const GET = route<{ id: string }>(async ({ ctx, params }) => files.contactCardImages(ctx, params.id));
