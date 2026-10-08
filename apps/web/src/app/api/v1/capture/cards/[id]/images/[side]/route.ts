import { badRequest, files } from "@linkos/api";
import { route } from "@/lib/server";
import { uploadRoute } from "@/lib/upload";

const side = (s: string) => {
  if (s !== "front" && s !== "back") throw badRequest("invalid_side");
  return s;
};

// F-019 명함 원본 보관 (opt-in per scan): encrypted at rest, re-encoded + scanned (F-172), retention applied
export const PUT = uploadRoute<{ id: string; side: string }>(async ({ ctx, params, bytes }) => files.attachCardImage(ctx, params.id, side(params.side), bytes), {
  maxBytes: 16 * 1024 * 1024,
  idempotencyScope: "card-image",
});
export const DELETE = route<{ id: string; side: string }>(async ({ ctx, params }) => files.deleteCardImage(ctx, params.id, side(params.side)));
