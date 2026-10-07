import { capture } from "@linkos/api";
import { parse, route } from "@/lib/server";

// captureBusinessCard — OCR lines (on-device tesseract) → structured fields w/ confidence (F-015~F-020)
export const POST = route(async ({ ctx, body }) => capture.captureBusinessCard(ctx, parse(capture.captureInput, body)), { status: 202 });
