import { relationship } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000), kind: z.enum(["text", "voice"]).default("text") }), body);
  return relationship.addNote(ctx, params.id, b.body, b.kind);
}, { status: 201 });
