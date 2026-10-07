import { files } from "@linkos/api";
import { route } from "@/lib/server";
import { uploadRoute } from "@/lib/upload";

// F-024 딥 프로필 미디어/파일: list is ACL-filtered for the viewer (public < business < trusted < partner)
export const GET = route<{ id: string }>(async ({ ctx, params }) => files.listProfileMedia(params.id, ctx.userId), { auth: false });
export const POST = uploadRoute<{ id: string }>(
  async ({ ctx, params, bytes, search, filename }) =>
    files.addProfileMedia(ctx, params.id, bytes, files.mediaMeta.parse({ title: search.get("title"), visibility: search.get("visibility") ?? undefined }), filename),
  { maxBytes: 21 * 1024 * 1024, idempotencyScope: "profile-media" },
);
