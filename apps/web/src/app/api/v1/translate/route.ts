import { comms } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-112 언어 번역 — AI translation (labelled), falls back to the original text with a notice
export const POST = route(async ({ ctx, body }) => comms.translate(ctx, parse(comms.translateInput, body)));
