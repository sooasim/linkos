import { recording } from "@linkos/api";
import { uploadRoute } from "@/lib/upload";

// F-081 chunked upload: one self-contained audio part (~50s) per request, idempotent per (recording, seq)
export const PUT = uploadRoute<{ id: string; rid: string; seq: string }>(
  async ({ ctx, params, bytes, search }) =>
    recording.uploadPart(ctx, params.id, params.rid, Number(params.seq), bytes, recording.partMeta.parse({ offsetMs: search.get("offsetMs") ?? 0, durationMs: search.get("durationMs") ?? undefined })),
  { maxBytes: 12 * 1024 * 1024 },
);
