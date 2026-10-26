// capture module — Capture & OCR (F-010~F-021)
// OCR(텍스트 인식)은 클라이언트(tesseract.js, 기기 내) 또는 외부 OCR 어댑터가 수행하고,
// 의미 구조화는 서버의 결정적 파서가 수행한다(원문 없는 값 생성 금지, provenance+confidence 보존).
import { type ExtractedField, type ExtractionResult, type OcrLine, REVIEW_THRESHOLD, needsReview, parseBadge, parseBusinessCard, toDraft } from "@linkos/domain";
import type pg from "pg";
import { z } from "zod";
import { one, pool, tx } from "../lib/db";
import { ApiError, notFound, unauthorized } from "../lib/errors";
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

// ---------- F-015 서버 OCR 어댑터 (사진 → 글자줄) ----------

/** 명함 한 장의 상한. 기기에서 보정·축소해 보내므로 이보다 커질 일이 없다. */
const OCR_MAX_BYTES = 6 * 1024 * 1024;
const OCR_MIME = { "image/jpeg": true, "image/png": true, "image/webp": true } as const;

export const ocrInput = z.object({
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  /** base64 (data: 접두사 없이) */
  image: z.string().max(Math.ceil((OCR_MAX_BYTES * 4) / 3) + 1024),
});

/**
 * POST /capture/ocr — 사진에서 글자줄만 읽어 돌려준다. **저장하지 않는다.**
 *
 * 기기 내 엔진(PP-OCRv5)이 못 읽는 명함이 있어서 둔 갈래다. 모델은 보이는 글자만
 * 옮겨 적고, 칸 가르기는 /capture/cards 의 결정적 파서가 한다 — 저장되는 값은
 * 여전히 원문의 부분 문자열이다(규칙 6).
 *
 * 사진은 이 요청에서만 쓰이고 어디에도 쓰지 않는다(원본 보관은 F-019 의 별도 동작이다).
 * 로그인 없이도 쓸 수 있어야 한다 — 게스트가 링크에서 명함을 찍는 길이 그렇다(F-055).
 * 대신 IP 기준으로 조인다.
 */
export async function ocrCardImage(ctx: Ctx, input: z.infer<typeof ocrInput>): Promise<{ lines: OcrLine[]; engine: string }> {
  if (ctx.userId) {
    await rateLimit(`ocr:${ctx.userId}`, 120, 3600);
  } else {
    /*
     * 게스트 OCR 은 로그인 없이 쓰는 유료 외부 경로(비전 어댑터)다. per-IP 키의 ctx.ip 는
     * X-Forwarded-For 첫 값이라(신뢰 프록시 검증 없음) 헤더를 돌려가며 IP 를 바꾸면 버킷이
     * 매번 새로 잡혀 유료 호출이 무제한이 된다. per-IP 위에 게스트 전체 상한을 하나 더 둔다 —
     * 넘치면 429 로 떨어지고 클라이언트(ocrServer)는 기기 내 엔진으로 폴백하므로 하드 실패가
     * 아니다(인식이 멈추지 않는다).
     */
    await rateLimit(`ocr:ip:${ctx.ip}`, 20, 3600);
    await rateLimit("ocr:guest:all", 1000, 3600);
  }
  const image = Buffer.from(input.image, "base64");
  if (!image.length || image.length > OCR_MAX_BYTES) throw new ApiError(400, "invalid_image", "사진 크기가 올바르지 않습니다.");
  if (!(input.mime in OCR_MIME)) throw new ApiError(400, "invalid_image", "jpg · png · webp 만 읽을 수 있습니다.");
  const { visionLines } = await import("../lib/llm");
  const read = await visionLines({ image, mime: input.mime, ownerUserId: ctx.userId ?? null, sourceId: "capture.ocr" });
  // 키가 없거나 실패하면 빈 목록 — 화면은 기기 내 엔진 결과를 그대로 쓴다
  if (!read) return { lines: [], engine: "" };
  // 분석 이벤트는 따로 남기지 않는다 — ai_runs 와 cost 에 이미 기록된다(원문은 남기지 않는다)
  return { lines: read.lines.map((text) => ({ text, confidence: 0.9 })), engine: `vision:${read.model}` };
}

export async function getCaptureJob(ctx: Ctx, id: string) {
  if (!ctx.userId) throw unauthorized();
  const r = await one<any>("SELECT id, contact_id, raw_ocr, structured_data, confidence, captured_at FROM business_cards WHERE id=$1 AND captured_by=$2", [id, ctx.userId], pool());
  if (!r) throw notFound("capture job");
  return { id: r.id, status: "completed", contactId: r.contact_id, fields: r.structured_data?.fields ?? [], draft: r.structured_data?.draft ?? r.structured_data, confidence: r.confidence, capturedAt: r.captured_at, language: r.raw_ocr?.language };
}
