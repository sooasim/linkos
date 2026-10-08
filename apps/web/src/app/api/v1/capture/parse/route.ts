import { parseBusinessCard, needsReview } from "@linkos/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";
import { rateLimit } from "@linkos/api";

// Guest-side structuring (no account): parse only, nothing is stored (F-055 게스트 명함 촬영)
const schema = z.object({ lines: z.array(z.object({ text: z.string().max(500), confidence: z.number().min(0).max(100).optional() })).max(120) });

export const POST = route(async ({ ctx, body }) => {
  await rateLimit(`parse:${ctx.ip}`, 30, 600);
  const r = parseBusinessCard(parse(schema, body).lines);
  return { ...r, fields: r.fields.map((f) => ({ ...f, needsReview: needsReview(f) })) };
}, { auth: false });
