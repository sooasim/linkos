/**
 * M07 Lead & CRM — P-100~P-112.
 *
 * 출처: 02_모듈명세_제품요구사항.md M07
 *   목적: 상담 문의를 리드로 만들고 후속 조치를 관리.
 *   수용 기준: **리드 조회는 담당자/조직 권한을 따르고, 마케팅 동의는 상담 처리 동의와 분리된다.**
 *
 * 이 모듈이 다루는 데이터는 이 제품에서 가장 민감하다 — **비회원이 남긴 연락처**다. 그래서 네 가지를
 * 코드 구조로 못 박는다:
 *
 *   1. **동의가 먼저다 (N-11 / P-101).** `validateLeadConsents()` 가 통과하기 전에는 어떤 INSERT 도 하지 않고,
 *      동의는 목적별로 **분리된 행**으로 저장한다. 한 행에 여러 목적을 담는 컬럼이 스키마에 없다.
 *   2. **평문 연락처는 저장도, 응답도 하지 않는다 (P-102).** 저장은 `encryptField()`, 목록은 `contact_masked`.
 *      복호화는 담당자의 **상세 조회** 한 곳에서만 일어나고 그 조회는 감사로그에 남는다.
 *   3. **모든 조회에 소유자 조건이 붙는다 (P-103, IDOR).** `scopeSql()` 없이 `leads` 를 읽는 함수를 만들지 않는다.
 *      권한 판정 자체는 domain 의 `can()` 이 하고, SQL 은 **데이터 계층에서 한 번 더** 같은 경계를 긋는다.
 *   4. **지표는 혼자 나가지 않는다 (N-8 / P-111).** 응답시간은 표본 수·기간·산정근거를 같이 돌려주고,
 *      표본이 없으면 수치를 아예 돌려주지 않는다.
 */

import { randomUUID } from "node:crypto";
import {
  assertCan,
  canChangeStage,
  formatMetricDisclosure,
  hashVisitor,
  isOrgManager,
  maskContact,
  sanitizeText,
  validateLeadConsents,
  validateMetricClaim,
  type Capability,
  type CapabilityTarget,
  type ConsentInput,
  type LeadStage,
  type MemberRole,
  type PlatformRole,
  type Principal,
} from "@proplus/domain";
import { writeAudit, writeSystemAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, pool, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { decryptField, encryptField } from "../lib/crypto";
import { enqueue } from "../lib/outbox";

/**
 * P-199 / 데이터모델 §6: 리드 보존기간의 **기본값**.
 *
 * TODO(P-199): 이 값은 법률검토 후 확정한다. 확정되면 코드가 아니라 `retention_policies('lead').retain_days` 에
 * 넣고 이 상수는 "정책 행이 비어 있을 때의 안전한 기본값"으로만 남긴다. 180일은 문서가 정한 값이 아니라
 * 상담 후속 연락이라는 목적에 비해 과하지 않은 선을 임시로 잡은 것이다 (미결정 §2).
 */
const DEFAULT_LEAD_RETENTION_DAYS = 180;

/** P-112: 같은 연락처가 이 창 안에 다시 들어오면 중복 제출로 본다. */
const DUPLICATE_WINDOW_MINUTES = 10;

/** P-112: 본문에 링크가 이 개수 이상이면 스팸으로 거부한다. 정상 문의는 참고 링크 하나면 충분하다. */
const MAX_LINKS_IN_MESSAGE = 2;

/** P-134: 저장을 허용하는 UTM 키. 임의 키를 받으면 공개 폼이 아무 데이터나 넣는 통로가 된다. */
const UTM_KEYS: readonly string[] = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

const LINK_RE = /\b(?:https?:\/\/|www\.)/gi;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** 익명화된 리드의 표식. 복호화를 시도하지 않는 기준으로도 쓴다. */
const PURGED_MARK = "[삭제됨]";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateLeadInput {
  contactName: string;
  contactKind: "email" | "phone";
  /** 평문 연락처. 이 값은 **암호화되어 저장되고 응답에는 담기지 않는다** (P-102). */
  contact: string;
  purpose?: string | null;
  message?: string | null;
  offerId?: string | null;
  /** 목적별로 한 건씩. `service` 는 필수, `marketing` 은 선택이다 (N-11). */
  consents: readonly ConsentInput[];
  utm?: Record<string, unknown> | null;
}

export interface CreatedLead {
  id: string;
  stage: LeadStage;
  /** P-102: 제출자에게도 원문을 되돌려주지 않는다. 접수 확인에는 마스킹으로 충분하다. */
  contactMasked: string;
  createdAt: string;
  retentionUntil: string;
}

export interface LeadListItem {
  id: string;
  profileId: string;
  organizationId: string | null;
  offerId: string | null;
  contactName: string;
  contactKind: "email" | "phone";
  /** 목록 경로는 **복호화하지 않는다.** 마스킹 값은 DB 컬럼에 그대로 있다 (P-102). */
  contactMasked: string;
  purpose: string | null;
  stage: LeadStage;
  assignedTo: string | null;
  utm: Record<string, unknown>;
  firstResponseAt: string | null;
  createdAt: string;
}

export interface LeadDetail extends LeadListItem {
  message: string | null;
  /** 담당자 상세 조회에서만 채워진다. 익명화된 리드는 null 이다. */
  contact: string | null;
  contactPurged: boolean;
  retentionUntil: string;
  profileSlug: string;
}

export interface LeadFilter {
  profileId?: string | null;
  stage?: LeadStage | null;
  assignedTo?: string | null;
  organizationId?: string | null;
  from?: Date | string | null;
  to?: Date | string | null;
  limit?: number;
  offset?: number;
}

export interface LeadExportFilter extends LeadFilter {
  /** 원문 연락처를 포함할지. true 면 `accessPurpose` 가 필수다 (P-109 / P-165). */
  includeContact?: boolean;
  accessPurpose?: string | null;
}

export interface LeadNoteView {
  id: string;
  authorId: string;
  note: string;
  createdAt: string;
}

export interface ResponseTimeStats {
  periodStart: string;
  periodEnd: string;
  /** 기간 내 접수된 전체 리드 수(= 분모 후보). */
  totalLeads: number;
  /** 실제 집계에 쓰인 표본 수(첫 응답이 기록된 리드). N-8 의 분모다. */
  sampleSize: number;
  averageMinutes: number | null;
  medianMinutes: number | null;
  /** 수치와 **반드시 함께** 렌더해야 하는 문구. null 이면 수치를 표시하지 않는다 (N-8). */
  disclosure: string | null;
  /** false 면 표본이 없어 공개 가능한 지표가 아니다. 호출부는 수치를 그리지 않는다. */
  publishable: boolean;
  basis: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-100 공개 상담 요청 폼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 비회원이 공개 프로필에서 상담을 요청한다. **인증 없이** 호출된다 (`ctx.userId` 는 null 이다).
 *
 * 순서가 곧 정책이다:
 *   (1) rate limit (P-112) — 검증·DB 작업 전에 막는다. 스팸이 비용을 쓰게 하지 않는다.
 *   (2) 동의 검사 (N-11 / P-101) — 통과 전에는 아무것도 저장하지 않는다.
 *   (3) 한 트랜잭션: 동의 분리 INSERT → 리드 INSERT → outbox → 담당자 알림.
 *   (4) 반환값에 연락처 원문 없음 (P-102).
 *
 * 왜 알림 메일을 여기서 보내지 않는가: P-107 수용기준이 "outbox 를 통해 전송, 실패 시 재시도"다.
 * 발송을 이 경로에 넣으면 SMTP 장애가 **상담 접수 자체를 실패시킨다** — 고객의 문의가 사라지는 쪽이
 * 알림이 늦는 쪽보다 훨씬 나쁘다. 워커가 `lead.created` 를 보고 보낸다.
 */
export async function createLead(ctx: Ctx, slug: string, input: CreateLeadInput): Promise<CreatedLead> {
  // (1) P-112: slug+IP 로 버킷을 나눈다. IP 만으로 묶으면 같은 회선의 다른 프로필 문의가 서로를 막는다.
  await consumeLimit("lead.create", `${slug}:${ctx.ip}`);

  // (2) N-11: 실패는 badRequest 다. 동의 없이 저장하는 경로는 존재하지 않는다.
  const consents = Array.isArray(input.consents) ? input.consents : [];
  const consentVerdict = validateLeadConsents(consents);
  if (!consentVerdict.ok) throw badRequest(consentVerdict.code, consentVerdict.message);

  const contactKind = input.contactKind === "phone" ? "phone" : "email";
  const contact = String(input.contact ?? "").trim();
  if (!isValidContact(contactKind, contact)) {
    throw badRequest("invalid_contact", "연락처 형식이 올바르지 않습니다.");
  }
  const contactName = sanitizeText(input.contactName ?? "", 80);
  if (contactName.length < 1) throw badRequest("contact_name_required", "성함을 입력하세요.");

  const purpose = input.purpose ? sanitizeText(input.purpose, 200) : null;
  const message = input.message ? sanitizeText(input.message, 2000) : null;
  // P-112: 링크 스팸. sanitizeText 뒤에 세는 이유는 태그·엔티티로 링크를 숨기는 입력을 먼저 평문화해야 하기 때문이다.
  if (message && (message.match(LINK_RE) ?? []).length >= MAX_LINKS_IN_MESSAGE) {
    throw badRequest("link_spam", "본문에 링크가 너무 많습니다.");
  }

  // 공개 폼이므로 **공개된 프로필에만** 리드가 붙는다. 미공개·탈퇴 계정의 slug 는 존재하지 않는 것과 같다.
  const target = await one<{ id: string; user_id: string }>(
    `SELECT p.id, p.user_id
       FROM profiles p
       JOIN users u ON u.id = p.user_id
      WHERE p.slug = $1 AND p.published_at IS NOT NULL AND u.status = 'active' AND u.deleted_at IS NULL`,
    [slug],
  );
  if (!target) throw notFound("profile");

  // 상품 문의는 **그 프로필의 상품**이어야 한다. 다른 사람의 상품 id 를 끼워 넣는 경로를 막는다.
  let offerOrgId: string | null = null;
  const offerId = input.offerId ? String(input.offerId) : null;
  if (offerId) {
    const offer = await one<{ id: string; owner_type: string; owner_id: string }>(
      `SELECT id, owner_type, owner_id FROM offers WHERE id = $1 AND profile_id = $2`,
      [offerId, target.id],
    );
    if (!offer) throw badRequest("offer_not_found", "문의 대상 상품을 찾을 수 없습니다.");
    if (offer.owner_type === "organization") offerOrgId = offer.owner_id;
  }

  const contactMasked = maskContact(contactKind, contact);

  // P-112 중복 제출 억제. 마스킹 값으로 비교하는 이유: 암호문은 IV 가 매번 달라 같은 값을 찾을 수 없고,
  // 평문을 비교용으로 따로 저장하는 것은 P-102 를 깨는 일이다. 마스킹 값은 결정적이라 이 용도로 충분하다.
  const dup = await one<{ id: string }>(
    `SELECT id FROM leads
      WHERE profile_id = $1 AND contact_masked = $2
        AND created_at > now() - make_interval(mins => $3::int)
      LIMIT 1`,
    [target.id, contactMasked, DUPLICATE_WINDOW_MINUTES],
  );
  if (dup) throw conflict("duplicate_lead", "방금 접수된 요청이 있습니다. 잠시 후 다시 시도하세요.");

  const organizationId = offerOrgId ?? (await soleActiveOrgOf(target.user_id));
  const retentionUntil = new Date(Date.now() + (await leadRetentionDays()) * 86_400_000);
  const utm = pickUtm(input.utm);

  // leads.consent_record_id 가 consent_records 를 가리키고, 동의 행은 어느 리드의 것인지(subject_ref)를
  // 가리켜야 한다. 순환을 피하려고 리드 id 를 먼저 만든다 — DB 기본값(gen_random_uuid)과 같은 형식이다.
  const leadId = randomId();
  const contactSealed = encryptField(contact, `lead:${leadId}`);
  const ipHash = visitorHash(ctx);

  const created = await tx(async (c) => {
    // (3-a) N-11: 목적마다 **별개의 행**. 'service' 와 'marketing' 이 한 행을 공유하는 경로가 없다.
    let serviceConsentId: string | null = null;
    for (const consent of consents) {
      const row = await one<{ id: string }>(
        `INSERT INTO consent_records (subject_ref, purpose, granted, policy_version, ip_hash)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [`lead:${leadId}`, consent.purpose, consent.granted === true, consent.policyVersion, ipHash],
        c,
      );
      if (consent.purpose === "service" && consent.granted === true) serviceConsentId = row?.id ?? null;
    }
    // validateLeadConsents 가 보장하는 값이지만, NOT NULL FK 를 추측으로 채우지 않는다.
    if (!serviceConsentId) throw badRequest("consent_required", "상담 처리에 대한 동의가 필요합니다.");

    const lead = await one<{ id: string; stage: LeadStage; created_at: Date; retention_until: Date }>(
      `INSERT INTO leads
         (id, profile_id, organization_id, offer_id, contact_name, contact_channel_encrypted,
          contact_channel_kind, contact_masked, purpose, message, consent_record_id, assigned_to, utm, retention_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       RETURNING id, stage, created_at, retention_until`,
      [
        leadId,
        target.id,
        organizationId,
        offerId,
        contactName,
        contactSealed,
        contactKind,
        contactMasked,
        purpose,
        message,
        serviceConsentId,
        // P-105 기본 담당자는 프로필 소유자다. 조직 리드도 일단 소유자에게 붙고 재배정은 assign() 이 한다.
        target.user_id,
        JSON.stringify(utm),
        retentionUntil,
      ],
      c,
    );
    if (!lead) throw conflict("lead_create_failed", "상담 요청을 접수할 수 없습니다.");

    // (3-b) P-183: 알림·CRM 연동을 유발하는 쓰기이므로 같은 트랜잭션에서 기록한다.
    // payload 에는 식별자와 플래그만 — 이름·연락처·문의 본문은 담지 않는다 (N-13).
    await enqueue(c, {
      eventType: "lead.created",
      aggregateType: "lead",
      aggregateId: lead.id,
      tenantId: organizationId,
      actorId: null,
      correlationId: ctx.requestId,
      payload: {
        leadId: lead.id,
        profileId: target.id,
        assignedTo: target.user_id,
        offerId,
        contactKind,
        hasMessage: Boolean(message),
        marketingConsent: consents.some((x) => x.purpose === "marketing" && x.granted === true),
      },
    });

    // (3-c) P-107: 본문에 PII 를 넣지 않는다. "확인하러 오세요" 한 줄이면 충분하다.
    await c.query(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       VALUES ($1,'lead.created','새 상담 요청이 도착했습니다', $2, $3)`,
      [target.user_id, "워크스페이스에서 내용을 확인하세요.", `/app/leads/${lead.id}`],
    );

    await writeAudit(c, {
      eventType: "lead.created",
      actorId: null,
      tenantId: organizationId,
      aggregateType: "lead",
      aggregateId: lead.id,
      payload: { profileId: target.id, offerId, contactKind },
      correlationId: ctx.requestId,
    });

    return lead;
  });

  // (4) P-102: id 와 마스킹 값만.
  return {
    id: created.id,
    stage: created.stage,
    contactMasked,
    createdAt: created.created_at.toISOString(),
    retentionUntil: created.retention_until.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-103 리드 inbox
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 수용기준(P-103): **담당자·조직 권한 내에서만 조회된다 (IDOR 차단).**
 *
 * 목록은 복호화하지 않는다 — 담당자가 100건을 훑는 동작이 100번의 복호화와 감사로그를 만들 이유가 없고,
 * 화면에 필요한 것은 "같은 사람인지 알아보기"뿐이다 (P-102).
 */
export async function listLeads(ctx: Ctx, filter: LeadFilter = {}): Promise<LeadListItem[]> {
  const scope = await actorScope(ctx);
  const p = new Params();
  const where = [scopeSql(p, scope)];
  appendFilters(where, p, filter);

  const limit = clamp(filter.limit ?? 50, 1, 200);
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

  const rows = await q<LeadRow>(
    `SELECT l.id, l.profile_id, l.organization_id, l.offer_id, l.contact_name, l.contact_channel_kind,
            l.contact_masked, l.purpose, l.stage, l.assigned_to, l.utm, l.first_response_at, l.created_at
       FROM leads l
       JOIN profiles pr ON pr.id = l.profile_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC
      LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
    p.values,
  );
  return rows.map(toListItem);
}

/**
 * 담당자의 상세 조회. **여기가 복호화가 일어나는 유일한 곳**이고, 그래서 감사로그를 남긴다
 * (보안정책 §3 / P-165: 누가 언제 어떤 고객 연락처를 열었는지 복원 가능해야 한다).
 */
export async function getLead(ctx: Ctx, id: string): Promise<LeadDetail> {
  const scope = await actorScope(ctx);
  const row = await loadLead(scope, id);

  const purged = row.contact_channel_encrypted === "" || row.contact_masked === PURGED_MARK;
  const contact = purged ? null : decryptField(row.contact_channel_encrypted, `lead:${row.id}`);

  await writeAudit(pool(), {
    eventType: "lead.contact_viewed",
    actorId: scope.userId,
    tenantId: row.organization_id,
    aggregateType: "lead",
    aggregateId: row.id,
    // 연락처 자체는 남기지 않는다. 남겨야 하는 사실은 "열었다"다 (N-13).
    payload: { profileId: row.profile_id, contactKind: row.contact_channel_kind, purged },
    accessPurpose: "상담 처리",
    correlationId: ctx.requestId,
  });

  return {
    ...toListItem(row),
    message: row.message,
    contact,
    contactPurged: purged,
    retentionUntil: row.retention_until.toISOString(),
    profileSlug: row.profile_slug,
  };
}

/**
 * P-104: 허용된 전이만. 이력은 `leads_stage_history_trg` 가 남기므로 여기서 INSERT 하지 않는다 —
 * 애플리케이션이 깜빡해도 이력이 비지 않게 하는 것이 트리거를 둔 이유다.
 *
 * `first_response_at` 을 여기서 채우는 이유: 응답시간 지표(P-111)의 기준은 "담당자가 처음 움직인 시각"이고,
 * 상세를 열어 본 것은 응답이 아니다. 단계가 `new` 를 벗어나는 순간이 가장 가까운 관측점이다.
 */
export async function updateStage(ctx: Ctx, id: string, stage: LeadStage): Promise<LeadListItem> {
  const scope = await actorScope(ctx);
  const current = await loadLead(scope, id);

  if (!canChangeStage(current.stage, stage)) {
    throw conflict("invalid_stage_transition", "허용되지 않은 단계 변경입니다.");
  }

  return tx(async (c) => {
    const updated = await one<LeadRow>(
      `UPDATE leads
          SET stage = $2::lead_stage,
              first_response_at = CASE
                WHEN first_response_at IS NULL AND $2::lead_stage <> 'new' THEN now()
                ELSE first_response_at END
        WHERE id = $1
        RETURNING id, profile_id, organization_id, offer_id, contact_name, contact_channel_kind,
                  contact_masked, purpose, stage, assigned_to, utm, first_response_at, created_at`,
      [id, stage],
      c,
    );
    if (!updated) throw notFound("lead");

    await writeAudit(c, {
      eventType: "lead.stage_changed",
      actorId: scope.userId,
      tenantId: updated.organization_id,
      aggregateType: "lead",
      aggregateId: id,
      payload: { from: current.stage, to: stage },
      correlationId: ctx.requestId,
    });
    return toListItem(updated);
  });
}

/**
 * P-105: **같은 조직 멤버에게만** 배정한다.
 *
 * 조직이 없는(개인) 리드는 후보가 자기 자신뿐이다 — 조직 경계가 없는 상태에서 남에게 고객 연락처를
 * 넘길 수 있으면 "담당자 권한 내 조회"(P-103)가 무의미해진다.
 */
export async function assign(ctx: Ctx, id: string, userId: string): Promise<LeadListItem> {
  const scope = await actorScope(ctx);
  const lead = await loadLead(scope, id);

  must(scope.principal, "lead.assign", {
    ownerUserId: lead.owner_user_id,
    ...(lead.organization_id ? { organizationId: lead.organization_id } : {}),
  });

  if (!lead.organization_id) {
    if (userId !== lead.owner_user_id) {
      throw badRequest("assignee_not_allowed", "조직이 없는 리드는 프로필 소유자에게만 배정됩니다.");
    }
  } else {
    const member = await one<{ user_id: string }>(
      `SELECT user_id FROM memberships
        WHERE organization_id = $1 AND user_id = $2 AND status = 'active'
          AND (ended_at IS NULL OR ended_at > now())`,
      [lead.organization_id, userId],
    );
    if (!member) throw badRequest("assignee_not_member", "같은 조직의 활성 멤버에게만 배정할 수 있습니다.");
  }

  return tx(async (c) => {
    const updated = await one<LeadRow>(
      `UPDATE leads SET assigned_to = $2
        WHERE id = $1
        RETURNING id, profile_id, organization_id, offer_id, contact_name, contact_channel_kind,
                  contact_masked, purpose, stage, assigned_to, utm, first_response_at, created_at`,
      [id, userId],
      c,
    );
    if (!updated) throw notFound("lead");

    await c.query(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       VALUES ($1,'lead.assigned','상담이 배정되었습니다', $2, $3)`,
      [userId, "워크스페이스에서 내용을 확인하세요.", `/app/leads/${id}`],
    );
    await writeAudit(c, {
      eventType: "lead.assigned",
      actorId: scope.userId,
      tenantId: updated.organization_id,
      aggregateType: "lead",
      aggregateId: id,
      payload: { from: lead.assigned_to, to: userId },
      correlationId: ctx.requestId,
    });
    return toListItem(updated);
  });
}

/**
 * P-106: 비공개 메모. **고객·외부에 노출되는 경로를 만들지 않는다** —
 * 이 모듈에는 `lead_notes` 를 공개 DTO 로 바꾸는 함수가 없고, 공개 뷰(`public_*_view`)도 이 테이블을 모른다.
 */
export async function addNote(ctx: Ctx, id: string, note: string): Promise<LeadNoteView> {
  const scope = await actorScope(ctx);
  const lead = await loadLead(scope, id);

  const text = sanitizeText(note ?? "", 2000);
  if (text.length === 0) throw badRequest("note_required", "메모 내용을 입력하세요.");

  const row = await one<{ id: string; author_id: string; note: string; created_at: Date }>(
    `INSERT INTO lead_notes (lead_id, author_id, note) VALUES ($1,$2,$3)
     RETURNING id, author_id, note, created_at`,
    [lead.id, scope.userId, text],
  );
  if (!row) throw conflict("note_create_failed", "메모를 저장할 수 없습니다.");
  return { id: row.id, authorId: row.author_id, note: row.note, createdAt: row.created_at.toISOString() };
}

export async function listNotes(ctx: Ctx, id: string): Promise<LeadNoteView[]> {
  const scope = await actorScope(ctx);
  const lead = await loadLead(scope, id);
  const rows = await q<{ id: string; author_id: string; note: string; created_at: Date }>(
    `SELECT id, author_id, note, created_at FROM lead_notes WHERE lead_id = $1 ORDER BY created_at`,
    [lead.id],
  );
  return rows.map((r) => ({ id: r.id, authorId: r.author_id, note: r.note, createdAt: r.created_at.toISOString() }));
}

/**
 * P-109: 내보내기는 **대량조회**이므로 감사로그가 필수다 (CLAUDE.md §5).
 *
 * 기본값은 마스킹 연락처다. 원문을 받으려면 `includeContact` + `accessPurpose` 를 명시해야 한다 —
 * "왜 고객 연락처 전체를 꺼냈는가"에 답할 수 없는 export 를 만들지 않으려는 것이다 (P-165).
 */
export async function exportLeads(
  ctx: Ctx,
  filter: LeadExportFilter = {},
): Promise<{ rows: (LeadListItem & { contact?: string | null })[]; count: number; includedContacts: boolean }> {
  const scope = await actorScope(ctx);
  const includeContact = filter.includeContact === true;
  const accessPurpose = filter.accessPurpose ? sanitizeText(filter.accessPurpose, 200) : "";
  if (includeContact && accessPurpose.length === 0) {
    throw badRequest("access_purpose_required", "연락처를 포함한 내보내기에는 접근 사유가 필요합니다.");
  }

  const p = new Params();
  const where = [scopeSql(p, scope)];
  appendFilters(where, p, filter);
  const limit = clamp(filter.limit ?? 5000, 1, 10_000);

  const rows = await q<LeadRow & { contact_channel_encrypted: string }>(
    `SELECT l.id, l.profile_id, l.organization_id, l.offer_id, l.contact_name, l.contact_channel_kind,
            l.contact_masked, l.purpose, l.stage, l.assigned_to, l.utm, l.first_response_at, l.created_at,
            l.contact_channel_encrypted
       FROM leads l
       JOIN profiles pr ON pr.id = l.profile_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC
      LIMIT ${p.add(limit)}`,
    p.values,
  );

  const out = rows.map((r) => {
    const item = toListItem(r);
    if (!includeContact) return item;
    const purged = r.contact_channel_encrypted === "" || r.contact_masked === PURGED_MARK;
    return { ...item, contact: purged ? null : decryptField(r.contact_channel_encrypted, `lead:${r.id}`) };
  });

  await writeAudit(pool(), {
    eventType: "lead.exported",
    actorId: scope.userId,
    tenantId: filter.organizationId ?? null,
    aggregateType: "lead",
    aggregateId: null,
    payload: {
      count: out.length,
      includedContacts: includeContact,
      filter: { stage: filter.stage ?? null, profileId: filter.profileId ?? null, from: filter.from ?? null, to: filter.to ?? null },
    },
    accessPurpose: includeContact ? accessPurpose : "리드 목록 내보내기",
    correlationId: ctx.requestId,
  });

  return { rows: out, count: out.length, includedContacts: includeContact };
}

/**
 * P-110: 보존기간이 지난 리드를 **익명화**한다. 워커가 호출한다 (요청 문맥이 없으므로 `Ctx` 를 받지 않는다).
 *
 * 왜 DELETE 가 아니라 익명화인가: 지워야 하는 것은 **개인을 식별하는 값**이고, 단계·시각 같은 집계값은
 * 응답시간 지표(P-111)와 전환 분석(M09)의 분모다. 행을 지우면 과거 지표가 소급해서 바뀐다 —
 * 그건 N-8 이 막으려는 "재현되지 않는 수치"와 같은 문제다.
 * 비공개 메모는 내용 자체가 고객에 대한 기록이라 함께 삭제한다 (P-106).
 *
 * 동의 기록(`consent_records`)은 남긴다: 그 행에는 연락처가 없고(ip 는 해시), "무엇에 근거해 처리했는가"를
 * 증명하는 기록이기 때문이다 (보안정책 §3).
 */
export async function purgeExpired(now: Date): Promise<{ purged: number; notesDeleted: number }> {
  const cutoff = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const result = await tx(async (c) => {
    const purgedRows = await q<{ id: string }>(
      `UPDATE leads
          SET contact_channel_encrypted = '',
              contact_masked = $2,
              contact_name = $2,
              purpose = NULL,
              message = NULL,
              utm = '{}'::jsonb
        WHERE retention_until < $1 AND contact_channel_encrypted <> ''
        RETURNING id`,
      [cutoff, PURGED_MARK],
      c,
    );
    const ids = purgedRows.map((r) => r.id);
    if (ids.length === 0) return { purged: 0, notesDeleted: 0 };

    const notes = await q<{ id: string }>(
      `DELETE FROM lead_notes WHERE lead_id = ANY($1::uuid[]) RETURNING id`,
      [ids],
      c,
    );
    return { purged: ids.length, notesDeleted: notes.length };
  });

  if (result.purged > 0) {
    await writeSystemAudit({
      eventType: "lead.purged",
      actorId: null,
      actorRole: "system",
      aggregateType: "lead",
      aggregateId: null,
      payload: { purged: result.purged, notesDeleted: result.notesDeleted, cutoff: cutoff.toISOString() },
      accessPurpose: "보존기간 만료 처리",
    });
  }
  return result;
}

/**
 * P-111 / N-8: 응답시간은 **표본 수와 측정 기간을 함께** 돌려준다. 단독 수치를 만들지 않는다.
 *
 * 표본(첫 응답이 기록된 리드)이 없으면 `averageMinutes` 는 null 이고 `publishable` 은 false 다 —
 * "평균 0분"이나 "데이터 없음을 0으로"가 화면에 나가는 것을 함수 반환값 수준에서 막는다.
 * `disclosure` 는 도메인의 `formatMetricDisclosure()` 가 만든다. 포맷을 여기서 조립하면
 * 기간·분모가 빠진 변형이 생긴다.
 */
export async function responseTimeStats(ctx: Ctx, from: Date | string, to: Date | string): Promise<ResponseTimeStats> {
  const scope = await actorScope(ctx);
  const start = toDate(from, "from");
  const end = toDate(to, "to");
  if (end.getTime() < start.getTime()) throw badRequest("period_order_invalid", "측정 종료일이 시작일보다 앞설 수 없습니다.");

  const p = new Params();
  const where = [scopeSql(p, scope)];
  where.push(`l.created_at >= ${p.add(start)}`);
  where.push(`l.created_at < ${p.add(end)}`);

  const row = await one<{ total: number; responded: number; avg_sec: number | null; median_sec: number | null }>(
    `SELECT count(*)::int AS total,
            count(l.first_response_at)::int AS responded,
            avg(extract(epoch from (l.first_response_at - l.created_at)))::float8 AS avg_sec,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch from (l.first_response_at - l.created_at))::float8
            ) AS median_sec
       FROM leads l
       JOIN profiles pr ON pr.id = l.profile_id
      WHERE ${where.join(" AND ")}`,
    p.values,
  );

  const periodStart = isoDate(start);
  const periodEnd = isoDate(end);
  const basis = "첫 응답(단계 변경) 시각 − 접수 시각. 응답이 기록되지 않은 리드는 분모에서 제외.";
  const sampleSize = row?.responded ?? 0;
  const averageMinutes = row?.avg_sec != null ? round1(row.avg_sec / 60) : null;
  const medianMinutes = row?.median_sec != null ? round1(row.median_sec / 60) : null;

  const claim = {
    metricCode: "response_time",
    value: averageMinutes ?? 0,
    unit: "분",
    periodStart,
    periodEnd,
    sampleSize,
    basis,
  };
  // N-8 과 같은 판정을 도메인에 맡긴다 — 표본 0·근거 공백은 여기서도 "공개 불가"다.
  const verdict = validateMetricClaim(claim);
  const publishable = verdict.ok && averageMinutes !== null;

  return {
    periodStart,
    periodEnd,
    totalLeads: row?.total ?? 0,
    sampleSize,
    averageMinutes: publishable ? averageMinutes : null,
    medianMinutes: publishable ? medianMinutes : null,
    disclosure: publishable ? formatMetricDisclosure(claim) : null,
    publishable,
    basis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부
// ─────────────────────────────────────────────────────────────────────────────

type LeadRow = {
  id: string;
  profile_id: string;
  organization_id: string | null;
  offer_id: string | null;
  contact_name: string;
  contact_channel_kind: "email" | "phone";
  contact_masked: string;
  purpose: string | null;
  stage: LeadStage;
  assigned_to: string | null;
  utm: Record<string, unknown> | null;
  first_response_at: Date | null;
  created_at: Date;
  /** 상세·export 경로만 SELECT 한다. 목록 쿼리는 아예 꺼내지 않는다 (P-102). */
  contact_channel_encrypted?: string;
  message?: string | null;
  retention_until?: Date;
  profile_slug?: string;
  owner_user_id?: string;
};

type LeadDetailRow = LeadRow & {
  contact_channel_encrypted: string;
  message: string | null;
  retention_until: Date;
  profile_slug: string;
  owner_user_id: string;
};

interface ActorScope {
  userId: string;
  principal: Principal;
  /** `isOrgManager()` 가 관리자로 인정한 조직만. 권한 판정은 domain 이 하고 여기서는 결과를 쓴다. */
  managedOrgIds: string[];
}

/**
 * SQL 파라미터 수집기.
 *
 * 값은 **언제나** `$n` 으로만 들어간다 (ADR-007 / CLAUDE.md §5). 문자열로 이어 붙이는 것은
 * 자리표시자와 고정된 컬럼명뿐이고, 사용자 입력이 SQL 문자열에 섞이는 경로는 이 클래스에 없다.
 */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * P-103 IDOR 차단의 **데이터 계층 쪽 짝**.
 *
 * 세 가지 중 하나여야 읽을 수 있다: 프로필 소유자 본인 · 배정된 담당자 · 그 리드가 속한 조직의 관리자.
 * `can('lead.read')` 와 같은 조건을 SQL 로 한 번 더 긋는 이유는, 권한 검사를 깜빡한 쿼리가
 * 추가되더라도 이 함수를 쓰지 않으면 컴파일되지 않도록 만들기 위함이다(WHERE 조립이 여기만 있다).
 */
function scopeSql(p: Params, scope: ActorScope): string {
  const me = p.add(scope.userId);
  const orgs = p.add(scope.managedOrgIds);
  return `(pr.user_id = ${me} OR l.assigned_to = ${me} OR (l.organization_id IS NOT NULL AND l.organization_id = ANY(${orgs}::uuid[])))`;
}

function appendFilters(where: string[], p: Params, filter: LeadFilter): void {
  if (filter.profileId) where.push(`l.profile_id = ${p.add(filter.profileId)}`);
  if (filter.stage) where.push(`l.stage = ${p.add(filter.stage)}::lead_stage`);
  if (filter.assignedTo) where.push(`l.assigned_to = ${p.add(filter.assignedTo)}`);
  if (filter.organizationId) where.push(`l.organization_id = ${p.add(filter.organizationId)}`);
  if (filter.from) where.push(`l.created_at >= ${p.add(toDate(filter.from, "from"))}`);
  if (filter.to) where.push(`l.created_at < ${p.add(toDate(filter.to, "to"))}`);
}

/** 상세 1건. 스코프 조건을 건 채로 읽으므로 권한 없는 id 는 404 다(존재 여부를 흘리지 않는다). */
async function loadLead(scope: ActorScope, id: string): Promise<LeadDetailRow> {
  const p = new Params();
  const scopeClause = scopeSql(p, scope);
  const idParam = p.add(id);
  const row = await one<LeadDetailRow>(
    `SELECT l.id, l.profile_id, l.organization_id, l.offer_id, l.contact_name, l.contact_channel_kind,
            l.contact_masked, l.contact_channel_encrypted, l.purpose, l.message, l.stage, l.assigned_to,
            l.utm, l.first_response_at, l.created_at, l.retention_until,
            pr.slug AS profile_slug, pr.user_id AS owner_user_id
       FROM leads l
       JOIN profiles pr ON pr.id = l.profile_id
      WHERE l.id = ${idParam} AND ${scopeClause}`,
    p.values,
  );
  if (!row) throw notFound("lead");

  // 도메인에 한 번 더 묻는다. SQL 과 ACL 의 결론이 갈리면(한쪽만 고쳐졌을 때) 더 좁은 쪽을 따른다.
  //
  // `assignedUserId` 를 넘기는 것이 중요하다: SQL 스코프는 `assigned_to = me` 를 허용하는데
  // ACL 에 그 사실을 알려 주지 않으면 **목록에는 보이는 리드의 상세가 403** 이 된다.
  // 두 곳이 같은 사실을 보고 판단해야 "더 좁은 쪽을 따른다" 가 의미를 가진다.
  must(scope.principal, "lead.read", {
    ownerUserId: row.owner_user_id,
    assignedUserId: row.assigned_to,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
  });
  return row;
}

async function actorScope(ctx: Ctx): Promise<ActorScope> {
  const userId = requireUser(ctx);
  const principal = await loadPrincipal(userId);
  const managedOrgIds = principal.memberships
    .map((m) => m.organizationId)
    .filter((orgId) => isOrgManager(principal, orgId));
  return { userId, principal, managedOrgIds };
}

/**
 * 권한 판단에 필요한 Principal 을 DB 에서 조립한다 (전략 §3).
 *
 * P-085 를 읽기 시점에 적용한다: `ended_at` 이 지난 활성 행은 `'revoked'` 로 바꿔 넘긴다 —
 * 퇴사자가 조직 리드(고객 PII)를 계속 볼 수 있으면 P-084 가 무의미해진다.
 *
 * (`modules/org.ts` 에 같은 함수가 있다. 중복을 택한 이유는 그 파일의 주석에 적었다.)
 */
async function loadPrincipal(userId: string): Promise<Principal> {
  const user = await one<{ platform_role: PlatformRole }>(
    `SELECT platform_role FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [userId],
  );
  if (!user) throw unauthorized("사용할 수 없는 계정입니다.");

  const rows = await q<{ organization_id: string; role: MemberRole; status: string }>(
    `SELECT organization_id, role,
            -- P-085: status='active' 라도 ended_at 이 지났으면 읽기 시점에 효력이 없다. 그 경우 'revoked'
            -- 로 넘긴다 — ELSE 로 떨어뜨리면 원래 'active' 가 그대로 나와 만료된 소속이 권한을 유지한다.
            CASE WHEN status = 'active' AND (ended_at IS NULL OR ended_at > now()) THEN 'active'
                 WHEN status = 'active' THEN 'revoked'
                 ELSE status END AS status
       FROM memberships WHERE user_id = $1`,
    [userId],
  );
  return {
    userId,
    platformRole: user.platform_role,
    memberships: rows.map((r) => ({ organizationId: r.organization_id, role: r.role, status: r.status })),
  };
}

/**
 * 권한 판정은 domain 의 `assertCan()` 이 한다. 이 래퍼가 하는 일은 `Error('forbidden:<cap>')` 에
 * HTTP 의미(403)를 붙이는 것뿐이다 (P-187: 모듈이 의미를 던지고 라우트는 직렬화만 한다).
 */
// 타깃 타입을 손으로 다시 적지 않고 domain 의 `CapabilityTarget` 을 그대로 쓴다.
// 좁게 복사해 두면 도메인이 필드를 늘려도(예: `assignedUserId`) 여기가 따라가지 못해,
// **ACL 은 담당자를 볼 수 있는데 모듈이 그 사실을 넘길 수 없는** 상태가 된다.
function must(principal: Principal, cap: Capability, target: CapabilityTarget): void {
  try {
    assertCan(principal, cap, target);
  } catch {
    throw forbidden("이 리드에 대한 권한이 없습니다.");
  }
}

/** P-199: 정책 행이 있으면 그 값을, 없으면 기본값을 쓴다 (데이터모델 §6). */
async function leadRetentionDays(): Promise<number> {
  const row = await one<{ retain_days: number | null }>(
    `SELECT retain_days FROM retention_policies WHERE data_type = 'lead'`,
  );
  const days = row?.retain_days;
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_LEAD_RETENTION_DAYS;
}

/**
 * 리드의 테넌트를 정한다.
 *
 * 활성 소속이 **정확히 하나**일 때만 조직 리드로 본다. 여러 조직에 걸친 사람의 문의를 임의의 한 조직에
 * 붙이면, 그 조직의 관리자가 볼 자격이 없는 고객 연락처를 보게 된다 — 모호하면 테넌트를 붙이지 않는 쪽이 맞다.
 */
async function soleActiveOrgOf(userId: string): Promise<string | null> {
  const rows = await q<{ organization_id: string }>(
    `SELECT organization_id FROM memberships
      WHERE user_id = $1 AND status = 'active' AND (ended_at IS NULL OR ended_at > now())
      LIMIT 2`,
    [userId],
  );
  return rows.length === 1 ? (rows[0]?.organization_id ?? null) : null;
}

/** P-134: 허용 키만, 길이 제한, 평문 정규화. 캠페인 파라미터는 공개 폼에서 오는 값이다. */
function pickUtm(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of UTM_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const clean = sanitizeText(value, 120);
    if (clean) out[key] = clean;
  }
  return out;
}

function isValidContact(kind: "email" | "phone", value: string): boolean {
  if (!value || value.length > 200) return false;
  if (kind === "email") return EMAIL_RE.test(value);
  const digits = value.normalize("NFKC").replace(/\D/g, "");
  // 국내 최단(02-123-4567 = 9) ~ E.164 최대(15) — redact.ts 의 전화 판정과 같은 범위를 쓴다.
  return digits.length >= 9 && digits.length <= 15;
}

/**
 * N-13: `consent_records.ip_hash` 에 원문 IP 를 넣지 않는다.
 *
 * salt 가 비면 IPv4 공간이 좁아 전수 대입으로 복원된다(보안정책 §3). 운영에서는 `VISITOR_SALT` 를 주입하고
 * 주기적으로 교체한다 — TODO: `.env.example` 에 `VISITOR_SALT` 항목 추가(분석 모듈과 같은 값을 쓴다).
 */
function visitorHash(ctx: Ctx): string {
  const salt = process.env.VISITOR_SALT ?? process.env.AUTH_SECRET ?? "";
  return hashVisitor(ctx.ip, ctx.userAgent, salt);
}

/**
 * 리드 id 를 애플리케이션에서 만든다 (DB 기본값 `gen_random_uuid()` 와 같은 v4 형식).
 * 동의 행의 `subject_ref` 가 리드를 가리켜야 하는데 리드는 동의 행을 FK 로 가리키므로,
 * 둘 중 하나의 id 를 미리 알아야 순환이 풀린다 (createLead 주석 참조).
 */
function randomId(): string {
  return randomUUID();
}

function toListItem(row: LeadRow): LeadListItem {
  return {
    id: row.id,
    profileId: row.profile_id,
    organizationId: row.organization_id,
    offerId: row.offer_id,
    contactName: row.contact_name,
    contactKind: row.contact_channel_kind,
    contactMasked: row.contact_masked,
    purpose: row.purpose,
    stage: row.stage,
    assignedTo: row.assigned_to,
    utm: row.utm ?? {},
    firstResponseAt: row.first_response_at ? row.first_response_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw unauthorized();
  return ctx.userId;
}

function toDate(v: Date | string, field: string): Date {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest("invalid_date", `${field} 날짜 형식이 올바르지 않습니다.`);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
