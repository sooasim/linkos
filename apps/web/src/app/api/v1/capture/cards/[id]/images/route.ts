import { files } from "@linkos/api";
import { route } from "@/lib/server";

// F-019 stored originals of a capture (signed, short-lived URLs)
export const GET = route<{ id: string }>(async ({ ctx, params }) => files.listCardImages(ctx, params.id));
