import { files } from "@linkos/api";
import { route } from "@/lib/server";
import { uploadRoute } from "@/lib/upload";

// F-156 공유 파일 (소개서/제안서) in a Connection Room
export const GET = route<{ id: string }>(async ({ ctx, params }) => files.listRoomFiles(ctx, params.id));
export const POST = uploadRoute<{ id: string }>(async ({ ctx, params, bytes, search, filename }) => files.addRoomFile(ctx, params.id, bytes, search.get("title"), filename), {
  maxBytes: 26 * 1024 * 1024,
  idempotencyScope: "room-file",
});
