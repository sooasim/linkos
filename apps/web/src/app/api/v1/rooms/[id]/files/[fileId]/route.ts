import { files } from "@linkos/api";
import { route } from "@/lib/server";

export const DELETE = route<{ id: string; fileId: string }>(async ({ ctx, params }) => files.deleteRoomFile(ctx, params.id, params.fileId));
