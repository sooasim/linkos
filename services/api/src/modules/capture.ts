// capture module — Capture & OCR (F-010~F-021)
// OCR(텍스트 인식)은 클라이언트(tesseract.js, 기기 내) 또는 외부 OCR 어댑터가 수행하고,
// 의미 구조화는 서버의 결정적 파서가 수행한다(원문 없는 값 생성 금지, provenance+confidence 보존).
import { type ExtractedField, type ExtractionResult, type OcrLine, REVIEW_THRESHOLD, needsReview, parseBadge, parseBusinessCard, toDraft } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { one, pool, tx } from "../lib/db";
import { ApiError, notFound, unauthorized } from "../lib/errors";
import { type Ctx, audit, emit, rateLimit } from "../lib/platform";
import { contactInput, duplicatesFor, getContactRow, insertContact } from "./relationship";

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
  badgeType: string | null;
  reviewThreshold: number;
  duplicates: { contactId: string; fullName: string; company: string | null; score: number; reasons: string[]; autoMergeable: boolean }[];
}

function parseCapture(input: z.infer<typeof captureInput>): { lines: OcrLine[]; result: ExtractionResult & { badgeType?: string | null } } {
  const lines: OcrLine[] = [...input.lines, ...(input.backLines ?? [])];
  // F-014/F-144: badges follow a different layout (name largest, then company, then role)
  return { lines, result: input.kind === "badge" ? parseBadge(lines) : parseBusinessCard(lines) };
}

/** Insert the business_cards row (+ outbox event) inside the caller's transaction. */
async function insertCapture(c: pg.PoolClient, ctx: Ctx, input: z.infer<typeof captureInput>, eventId: string | null = null) {
  const userId = ctx.userId!;
  const { lines, result } = parseCapture(input);
  const confidence = Object.fromEntries(result.fields.map((f) => [f.key, Math.round(f.confidence * 100) / 100]));
  const draft = toDraft(result.fields);
  const bc = await one<{ id: string }>(
    `INSERT INTO business_cards (captured_by, raw_ocr, structured_data, confidence, source, kind, event_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      userId,
      JSON.stringify({ engine: input.engine, side: input.side, kind: input.kind, lines, language: result.language, badgeType: result.badgeType ?? null }),
      JSON.stringify({ fields: result.fields, draft }),
      JSON.stringify(confidence),
      input.kind === "badge" ? "badge" : "scan",
      input.kind,
      eventId,
    ],
    c,
  );
  await emit(c, "card.extraction.completed", "business_card", bc!.id, { card_id: bc!.id, fields: result.fields.map((f) => f.key), confidence });
  await audit(c, ctx, "capture.created", "business_card", bc!.id, { fields: result.fields.length, kind: input.kind });
  return { id: bc!.id, result, draft };
}

async function dupView(userId: string, draft: Partial<Record<string, string>>) {
  const dups = draft.fullName
    ? await duplicatesFor(userId, { fullName: draft.fullName, company: draft.company, email: draft.email, phone: draft.mobile ?? draft.phone })
    : [];
  return dups.map((d) => ({ contactId: d.contact.id, fullName: d.contact.fullName, company: d.contact.company, score: d.score, reasons: d.reasons, autoMergeable: d.autoMergeable }));
}

/** POST /capture/cards — F-011 앞·뒤면 병합: back lines are appended as one record. */
export async function captureBusinessCard(ctx: Ctx, input: z.infer<typeof captureInput>): Promise<CaptureJob> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`capture:${userId}`, 300, 3600);
  const { id, result, draft } = await tx((c) => insertCapture(c, ctx, input));
  return {
    id,
    status: "completed",
    fields: result.fields.map((f) => ({ ...f, needsReview: needsReview(f) })),
    draft,
    unassigned: result.unassigned,
    language: result.language,
    badgeType: result.badgeType ?? null,
    reviewThreshold: REVIEW_THRESHOLD,
    duplicates: await dupView(userId, draft),
  };
}

// ---------- F-178/F-052 offline capture commit, F-014/F-144 badge → event lead ----------
export const commitInput = z.object({
  capture: captureInput.nullish(),
  contact: contactInput,
  eventId: z.string().uuid().nullish(),
});
export type CommitInput = z.infer<typeof commitInput>;

/**
 * POST /capture/commit (and /events/{id}/leads): OCR lines + the user-reviewed contact in ONE transaction.
 * This is what the offline outbox replays (with Idempotency-Key), so a queued scan becomes exactly one
 * business card + contact + encounter. With eventId the encounter is attached to the event as a lead.
 */
export async function commitCapture(ctx: Ctx, input: CommitInput) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await rateLimit(`capture:${userId}`, 300, 3600);
  const eventId = input.eventId ?? input.contact.encounter?.eventId ?? null;
  if (eventId) {
    const att = await one("SELECT 1 FROM event_attendees WHERE event_id=$1 AND user_id=$2", [eventId, userId]);
    if (!att) throw new ApiError(404, "not_found", "event not found");
  }
  const out = await tx(async (c) => {
    const cap = input.capture ? await insertCapture(c, ctx, input.capture, eventId) : null;
    const source = input.contact.source !== "manual" ? input.contact.source : eventId ? "event" : cap ? "scan" : "manual";
    const ids = await insertContact(c, userId, {
      ...input.contact,
      source,
      businessCardId: cap?.id ?? input.contact.businessCardId ?? null,
      encounter: { ...(input.contact.encounter ?? {}), ...(eventId ? { eventId } : {}) },
    });
    await audit(c, ctx, eventId ? "event.lead_captured" : "contact.created", "contact", ids.contactId, { source, eventId, kind: input.capture?.kind ?? null });
    return { ...ids, captureId: cap?.id ?? null, contact: await getContactRow(userId, ids.contactId, c) };
  });
  const dups = await dupView(userId, { fullName: out.contact.fullName, company: out.contact.company ?? undefined, email: out.contact.email ?? undefined, phone: out.contact.phone ?? undefined });
  return { ...out, eventId, duplicates: dups.filter((d) => d.contactId !== out.contactId) };
}

export async function getCaptureJob(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("SELECT id, contact_id, raw_ocr, structured_data, confidence, captured_at FROM business_cards WHERE id=$1 AND captured_by=$2", [id, ctx.userId], pool());
  if (!r) throw notFound("capture job");
  return { id: r.id, status: "completed", contactId: r.contact_id, fields: r.structured_data?.fields ?? [], draft: r.structured_data?.draft ?? r.structured_data, confidence: r.confidence, capturedAt: r.captured_at, language: r.raw_ocr?.language };
}
