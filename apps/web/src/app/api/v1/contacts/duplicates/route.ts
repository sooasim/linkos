import { relationship } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ fullName: z.string().max(120), company: z.string().max(160).nullish(), email: z.string().max(200).nullish(), phone: z.string().max(60).nullish(), excludeId: z.string().uuid().optional() });

export const POST = route(async ({ ctx, body }) => {
  const b = parse(schema, body);
  const d = await relationship.duplicatesFor(ctx.userId!, b, b.excludeId);
  return { candidates: d.map((x) => ({ contact: x.contact, score: x.score, reasons: x.reasons, autoMergeable: x.autoMergeable })) };
});
