// capture module — Capture & OCR (F-010~F-021)
// OCR(텍스트 인식)은 클라이언트(tesseract.js, 기기 내) 또는 외부 OCR 어댑터가 수행하고,
// 의미 구조화는 서버의 결정적 파서가 수행한다(원문 없는 값 생성 금지, provenance+confidence 보존).
import { type ExtractedField, type OcrLine, REVIEW_THRESHOLD, needsReview, parseBusinessCard, toDraft } from "@linkos/domain";
import { z } from "zod";
import { one, pool, tx } from "../lib/db";
import { notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit, rateLimit } from "../lib/platform";
import { duplicatesFor } from "./relationship";

export const captureInput = z.object({
  side: z.enum(["front", "back", "both"]).default("front"),
  kind: z.enum(["card", "badge"]).default("card"),
  engine: z.string().max(40).default("tesseract.js"),
  lines: z
    .array(
      z.object({
        text: z.string().max(500),
        confidence: z.number().min(0).max(100).optional(),
        bbox: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
      }),
    )
    .max(120),
  backLines: z.array(z.object({ text: z.string().max(500), confidence: z.number().min(0).max(100).optional() })).max(120).optional(),
});

export interface CaptureJob {
  id: string;
  status: "completed";
  fields: (ExtractedField & { needsReview: boolean })[];
  draft: ReturnType<typeof toDraft>;
  unassigned: { line: number; text: string }[];
  language: string;
  reviewThreshold: number;
  duplicates: { contactId: string; fullName: string; company: string | null; score: number; reasons: string[]; autoMergeable: boolean }[];
}

/** POST /capture/cards — F-011 앞·뒤면 병합: back lines are appended as one record. */
export async function captureBusinessCard(ctx: Ctx, input: z.infer<typeof captureInput>): Promise<CaptureJob> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`capture:${userId}`, 300, 3600);
  const lines: OcrLine[] = [...input.lines, ...(input.backLines ?? [])];
  const result = parseBusinessCard(lines);
  const confidence = Object.fromEntries(result.fields.map((f) => [f.key, Math.round(f.confidence * 100) / 100]));
  const draft = toDraft(result.fields);
  const id = await tx(async (c) => {
    const bc = await one<{ id: string }>(
      `INSERT INTO business_cards (captured_by, raw_ocr, structured_data, confidence, source) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, JSON.stringify({ engine: input.engine, side: input.side, kind: input.kind, lines, language: result.language }), JSON.stringify({ fields: result.fields, draft }), JSON.stringify(confidence), input.kind === "badge" ? "badge" : "scan"],
      c,
    );
    await emit(c, "card.extraction.completed", "business_card", bc!.id, { card_id: bc!.id, fields: result.fields.map((f) => f.key), confidence });
    await audit(c, ctx, "capture.created", "business_card", bc!.id, { fields: result.fields.length });
    return bc!.id;
  });
  const dups = draft.fullName
    ? await duplicatesFor(userId, { fullName: draft.fullName, company: draft.company, email: draft.email, phone: draft.mobile ?? draft.phone })
    : [];
  return {
    id,
    status: "completed",
    fields: result.fields.map((f) => ({ ...f, needsReview: needsReview(f) })),
    draft,
    unassigned: result.unassigned,
    language: result.language,
    reviewThreshold: REVIEW_THRESHOLD,
    duplicates: dups.map((d) => ({ contactId: d.contact.id, fullName: d.contact.fullName, company: d.contact.company, score: d.score, reasons: d.reasons, autoMergeable: d.autoMergeable })),
  };
}

export async function getCaptureJob(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("SELECT id, contact_id, raw_ocr, structured_data, confidence, captured_at FROM business_cards WHERE id=$1 AND captured_by=$2", [id, ctx.userId], pool());
  if (!r) throw notFound("capture job");
  return { id: r.id, status: "completed", contactId: r.contact_id, fields: r.structured_data?.fields ?? [], draft: r.structured_data?.draft ?? r.structured_data, confidence: r.confidence, capturedAt: r.captured_at, language: r.raw_ocr?.language };
}
