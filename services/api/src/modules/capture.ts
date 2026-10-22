// capture module — Capture & OCR (F-010~F-021)
// OCR(텍스트 인식)은 클라이언트(tesseract.js, 기기 내) 또는 외부 OCR 어댑터가 수행하고,
// 의미 구조화는 서버의 결정적 파서가 수행한다(원문 없는 값 생성 금지, provenance+confidence 보존).
import { type ExtractedField, type ExtractionResult, type OcrLine, REVIEW_THRESHOLD, needsReview, parseBadge, parseBusinessCard, toDraft } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { one, pool, tx } from "../lib/db";
import { ApiError, notFound, unauthorized } from "../lib/errors";
import { inspectUpload } from "../lib/filescan";
import { serverOcr, serverOcrAvailable } from "../lib/ocr";
import { type Ctx, audit, emit, rateLimit } from "../lib/platform";
import { recordCost, track } from "../lib/metering";
import { consume } from "./billing";
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
  await consume(c, userId, "ocr_scans"); // F-192 (402 with upgrade info when over the plan limit)
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
  // F-187: on-device OCR costs nothing server-side; hosted engines are priced per page
  const onDevice = /tesseract|on[-_]?device/i.test(input.engine);
  await recordCost(c, { userId, jobType: "ocr", jobId: bc!.id, provider: input.engine, rateKey: onDevice ? "ocr.page.on_device" : "ocr.page.server", units: input.backLines?.length ? 2 : 1 });
  await track(c, "card_scanned", { userId }, { kind: input.kind, side: input.side, fields: result.fields.length });
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

// ---------- 서버 OCR 폴백 (선택) ----------

/**
 * 기기 OCR 이 글자를 못 읽었을 때만 쓰는 두 번째 시도. 사진을 서버로 올려 호스팅 OCR(Google Vision)로
 * 다시 읽고, **의미 구조화는 같은 결정적 파서**가 한다(원문에 없는 값은 여전히 만들지 않는다).
 *
 * 사진이 기기를 떠나므로 사용자의 명시적 동의(`consent: true`)가 없으면 시작하지 않는다.
 * 업로드는 매직바이트 검사·픽셀 상한·재인코딩(EXIF 제거)을 거치고, **어디에도 저장하지 않는다** —
 * 남는 것은 인식된 줄과 신뢰도뿐이다(F-019 원본 보관은 사용자가 따로 켜는 별개 기능).
 */
export async function captureFromImage(ctx: Ctx, bytes: Buffer, opts: { consent: boolean; side?: "front" | "back"; kind?: "card" | "badge" }): Promise<CaptureJob & { engine: string; lines: OcrLine[] }> {
  if (!ctx.userId) throw unauthorized();
  if (!opts.consent) throw new ApiError(400, "consent_required", "사진을 서버로 보내 다시 인식하려면 동의가 필요합니다.");
  if (!serverOcrAvailable()) throw new ApiError(503, "server_ocr_not_configured", "이 서버에는 서버 OCR이 설정되지 않았습니다. 기기에서 다시 촬영하거나 직접 입력해 주세요.");
  await rateLimit(`capture:ocr:${ctx.userId}`, 40, 3600);
  const inspected = await inspectUpload("card_image", bytes);
  if (inspected.scanStatus === "quarantined") throw new ApiError(423, "file_quarantined", "보안 검사에서 격리된 이미지입니다.");
  const { lines, engine } = await serverOcr(inspected.bytes);
  if (!lines.length) throw new ApiError(422, "no_text_found", "사진에서 글자를 찾지 못했습니다. 명함 전체가 밝게 보이도록 다시 촬영해 주세요.");
  const job = await captureBusinessCard(ctx, { side: opts.side ?? "front", kind: opts.kind ?? "card", engine, lines, backLines: undefined });
  return { ...job, engine, lines };
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
