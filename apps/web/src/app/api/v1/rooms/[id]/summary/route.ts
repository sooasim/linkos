import { intro } from "@linkos/api";
import { route } from "@/lib/server";

// F-158 Room 요약 (LLM when configured, rule-based fallback)
export const POST = route<{ id: string }>(async ({ ctx, params }) => intro.summarizeRoom(ctx, params.id));
