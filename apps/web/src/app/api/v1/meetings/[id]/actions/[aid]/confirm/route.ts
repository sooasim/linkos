import { recording } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ accept: z.boolean(), description: z.string().trim().min(1).max(500).optional(), dueAt: z.string().datetime().nullish(), contactId: z.string().uuid().nullish() });

// F-102 Human confirmation of an AI/rule suggestion (F-085 To-do / F-086 약속)
export const POST = route<{ id: string; aid: string }>(async ({ ctx, params, body }) => {
  const b = parse(schema, body);
  return recording.confirmSuggestedAction(ctx, params.id, params.aid, b.accept, { description: b.description, dueAt: b.dueAt ?? null, contactId: b.contactId ?? null });
});
