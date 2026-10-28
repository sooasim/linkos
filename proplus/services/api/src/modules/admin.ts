/**
 * M12 Admin, Trust & Safety — 검증 콘솔 · 이의제기 · 신고 · 감사 · 운영 KPI (P-160~P-172).
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/
 *   02_모듈명세_제품요구사항.md M12 "수용 기준: 운영자 접근은 **최소권한, 목적 제한, 기록**을 따른다"
 *   01_기술백서_시스템아키텍처.md §5 "운영자 접근은 목적·승인·시간 제한·감사로그를 요구한다"
 *   04_보안_개인정보_신뢰정책.md §2 (관리자 내부 오남용) · §3 (접근 제한)
 *   06_개발로드맵_QA_운영계획.md §3 운영 KPI 대시보드
 *
 * 이 모듈의 두 가지 설계 원칙:
 *
 * 1. **권한을 계산하지 않는다.** 모든 함수는 domain 의 `can()/assertCan()` 에 묻고,
 *    그 입력인 Principal 은 `users.platform_role` + `memberships` 에서 조립한다 (전략 §3).
 *    `acl.ts` 가 검증·감사·신고 능력을 플랫폼 역할에만 주므로(조직 관리자는 받지 못한다)
 *    "회사가 자기 직원 증거를 스스로 승인"하는 길이 구조적으로 없다 (보안정책 §4.4).
 *
 * 2. **상태를 직접 쓰지 않고 proof 모듈을 거친다.** 재심 결정도 `proof.transition()` 을 호출한다 —
 *    `verifications` 를 여기서 INSERT 하면 N-1 관문(`canTransition`)을 우회하는 두 번째 경로가 생긴다.
 *    이 파일이 직접 쓰는 테이블은 M12 의 것뿐이다: `verification_notes`, `appeals`, `reports`, `users.platform_role`.
 *
 * 감사로그는 append-only 다(N-7). 이 파일에 audit_logs 의 UPDATE/DELETE 가 없는 것은 실수가 아니다 —
 * DB 트리거가 거부하므로 그런 코드는 런타임에 반드시 터진다.
 */

import {
  assertCan,
  canTransition,
  sanitizeText,
  type Capability,
  type MemberRole,
  type PlatformRole,
  type Principal,
  type ProofStatus,
  type VerificationMethod,
} from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, pool, q, tx, type Db } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { enqueue } from "../lib/outbox";
import { transition } from "./proof";

// ─────────────────────────────────────────────────────────────────────────────
// 상수 · 타입
// ─────────────────────────────────────────────────────────────────────────────

/** 검토 큐의 기본 범위. `evidence_queue_idx` 부분 인덱스와 같은 집합이다. */
const PENDING_STATUSES: readonly ProofStatus[] = ["submitted", "under_review", "needs_more_info"];

const PLATFORM_ROLES: readonly PlatformRole[] = ["none", "reviewer", "admin"];

const REPORT_SUBJECTS = ["profile", "badge", "offer", "lead"] as const;
type ReportSubject = (typeof REPORT_SUBJECTS)[number];

const REPORT_ACTIONS = ["in_review", "actioned", "dismissed"] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export type AppealOutcome = "upheld" | "overturned";

/** 사유 코드는 집계 대상이므로 모양만 제한한다 (목록은 운영이 채운다 — 미결정 §2). */
const REASON_CODE_RE = /^[a-z][a-z0-9_.:-]{1,59}$/;

export interface ReviewQueueFilter {
  /** 생략하면 대기 집합(submitted·under_review·needs_more_info). */
  status?: readonly ProofStatus[];
  evidenceType?: string | null;
  limit?: number;
  offset?: number;
}

export interface ReviewQueueItem {
  evidenceId: string;
  evidenceType: string;
  typeLabelKo: string;
  minMethod: VerificationMethod;
  requiresIssuer: boolean;
  issuerName: string | null;
  issuerAuthorityChecked: boolean;
  subjectType: "profile" | "organization";
  /** 공개 식별자까지만 둔다. 이름·연락처는 `evidenceDetail`(목적 기록 필수)에서만 나온다 (P-165). */
  subjectSlug: string | null;
  status: ProofStatus;
  submittedAt: string;
  waitingHours: number;
  fileCount: number;
  openAppeals: number;
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  /** P-160: 대기·처리중·완료 구분. 상태별 전체 건수. */
  countsByStatus: Record<string, number>;
}

export interface EvidenceDetail {
  evidenceId: string;
  evidenceType: string;
  typeLabelKo: string;
  minMethod: VerificationMethod;
  requiresIssuer: boolean;
  defaultTtlDays: number | null;
  badgeLabelKo: string;
  status: ProofStatus;
  sourceType: string;
  sourceReference: string | null;
  claim: Record<string, unknown>;
  submittedAt: string;
  issuer: { id: string; name: string; kind: string; authorityCheckedAt: string | null } | null;
  subject: { type: "profile" | "organization"; id: string; slug: string | null; displayName: string | null; region: string | null };
  organizationId: string | null;
  files: { fileId: string; contentType: string; byteSize: number; sha256: string; scanStatus: string; uploadedAt: string }[];
  verifications: {
    id: string;
    method: VerificationMethod;
    status: ProofStatus;
    scope: string | null;
    reasonCode: string | null;
    policyVersion: string;
    reviewerId: string | null;
    verifiedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }[];
  /** P-164: 검증자 내부 메모. **검증 콘솔 전용**이다 — 아래 함수 주석 참조. */
  notes: { id: string; verificationId: string; reviewerId: string; note: string; createdAt: string }[];
  appeals: { id: string; verificationId: string; status: string; createdAt: string; resolvedAt: string | null }[];
}

export interface AppealItem {
  appealId: string;
  verificationId: string;
  evidenceId: string;
  evidenceType: string;
  evidenceStatus: ProofStatus;
  verificationStatus: ProofStatus;
  status: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  openHours: number;
}

/** 재심 결정. 생략하면 overturned 는 재검토(`under_review`), upheld 는 원 결정 복원이다. */
export interface AppealDecision {
  to?: Extract<ProofStatus, "verified" | "rejected" | "under_review">;
  method?: VerificationMethod;
  scope?: string | null;
  reasonCode?: string | null;
  expiresAt?: Date | null;
}

export interface CreateReportInput {
  subjectType: ReportSubject;
  subjectId: string;
  reasonCode: string;
  detail?: string | null;
}

export interface ReportItem {
  reportId: string;
  subjectType: ReportSubject;
  subjectId: string;
  reasonCode: string;
  detail: string | null;
  status: string;
  createdAt: string;
  handledAt: string | null;
  openHours: number;
}

export interface AuditEntry {
  id: string;
  eventType: string;
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  accessPurpose: string | null;
  correlationId: string | null;
  occurredAt: string;
}

export interface KpiSummary {
  /** 모든 수치에 집계 범위를 붙인다 — 기간 없는 숫자는 N-8 이 금지하는 것과 같은 종류의 거짓말이다. */
  period: { from: string; to: string };
  profiles: { publishedTotal: number; publishedInPeriod: number; period: { from: string; to: string } };
  evidence: {
    submitted: number;
    verified: number;
    rejected: number;
    pending: number;
    /** 제출분 중 판정(승인·반려)까지 간 비율. 0~1. */
    decisionRate: number | null;
    avgDecisionHours: number | null;
    period: { from: string; to: string };
  };
  badges: {
    active: number;
    expiringSoon30d: number;
    /** 저장 상태는 active 인데 읽기 시점 판정으로는 만료된 것 (N-9 의 간격을 운영이 본다). */
    pastExpiry: number;
    revoked: number;
    disputed: number;
    asOf: string;
  };
  appeals: {
    created: number;
    open: number;
    upheld: number;
    overturned: number;
    /** P-168 번복률 = overturned / (upheld + overturned). */
    overturnRate: number | null;
    avgResolutionHours: number | null;
    period: { from: string; to: string };
  };
  reports: { created: number; open: number; actioned: number; dismissed: number; avgHandlingHours: number | null; period: { from: string; to: string } };
  conversion: { profileViews: number; leads: number; viewToLeadRate: number | null; period: { from: string; to: string } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Principal 을 **DB 사실로** 조립한다 (전략 §3). 요청에 담겨 온 역할은 쓰지 않는다.
 *
 * TODO(M01): `identity` 모듈이 안정되면 공용 조립기로 옮긴다. `proof.ts` 에도 같은 함수가 있고,
 *   지금 중복을 두는 이유는 모듈 간 import 사슬에 보안 함수를 끌어넣지 않으려는 것이다.
 */
async function principalOf(ctx: Ctx, db: Db = pool()): Promise<Principal> {
  if (!ctx.userId) throw unauthorized();
  const u = await one<{ platformRole: PlatformRole }>(
    `SELECT platform_role AS "platformRole"
       FROM users
      WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [ctx.userId],
    db,
  );
  if (!u) throw unauthorized("계정을 사용할 수 없습니다.");
  const ms = await q<{ organizationId: string; role: MemberRole; status: string }>(
    `SELECT organization_id::text AS "organizationId", role, status FROM memberships WHERE user_id = $1`,
    [ctx.userId],
    db,
  );
  return { userId: ctx.userId, platformRole: u.platformRole, memberships: ms };
}

/** `assertCan` 의 `Error('forbidden:<cap>')` 를 403 ApiError 로 바꾼다 (P-187 에러 규격). */
function mustCan(p: Principal, cap: Capability): void {
  try {
    assertCan(p, cap);
  } catch {
    throw forbidden(`권한이 없습니다 (${cap}).`);
  }
}

/**
 * P-165: 운영자가 개인 데이터를 조회할 때의 목적. **없으면 조회 자체를 거부한다.**
 * 기술백서 §5 가 요구하는 "목적·승인·시간 제한·감사로그" 중 목적과 감사로그를 코드로 강제하는 지점이다.
 */
function requirePurpose(raw: string | null | undefined): string {
  const v = sanitizeText(raw ?? "", 200);
  if (v.length < 3) {
    throw badRequest("access_purpose_required", "개인 데이터 조회에는 목적을 입력해야 합니다 (기술백서 §5).");
  }
  return v;
}

function requireReasonCode(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!REASON_CODE_RE.test(v)) {
    throw badRequest("reason_code_invalid", "사유 코드는 소문자·숫자·_.:- 로 된 2~60자 코드여야 합니다.");
  }
  return v;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoReq(v: Date | string | null | undefined): string {
  return iso(v) ?? new Date(0).toISOString();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ratio(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(raw ?? NaN)) return fallback;
  return Math.min(Math.max(1, Math.floor(raw as number)), max);
}

// ─────────────────────────────────────────────────────────────────────────────
// P-160 검증 검토 큐
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-160: 검토 큐. 검증자 역할만 접근하고, 상태별 건수를 함께 돌려준다(대기·처리중·완료 구분).
 *
 * 목록에 **이름·연락처를 담지 않는다.** 큐는 "무엇을 처리해야 하는가"를 보여 주는 화면이고,
 * 누구인지가 필요한 순간은 `evidenceDetail` 이며 그 호출은 목적과 함께 감사로그에 남는다 (P-165).
 */
export async function reviewQueue(ctx: Ctx, filter: ReviewQueueFilter = {}): Promise<ReviewQueue> {
  const p = await principalOf(ctx);
  mustCan(p, "evidence.review");

  const statuses = filter.status && filter.status.length > 0 ? [...filter.status] : [...PENDING_STATUSES];
  const limit = clampLimit(filter.limit, 50, 200);
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));

  const items = await q<{
    evidenceId: string;
    evidenceType: string;
    typeLabelKo: string;
    minMethod: VerificationMethod;
    requiresIssuer: boolean;
    issuerName: string | null;
    issuerAuthorityChecked: boolean;
    subjectType: "profile" | "organization";
    subjectSlug: string | null;
    status: ProofStatus;
    submittedAt: Date;
    waitingHours: string | number;
    fileCount: string | number;
    openAppeals: string | number;
  }>(
    `SELECT e.id::text        AS "evidenceId",
            e.evidence_type   AS "evidenceType",
            t.label_ko        AS "typeLabelKo",
            t.min_method      AS "minMethod",
            t.requires_issuer AS "requiresIssuer",
            i.name            AS "issuerName",
            (i.authority_checked_at IS NOT NULL) AS "issuerAuthorityChecked",
            e.subject_type    AS "subjectType",
            COALESCE(pr.slug, o.slug) AS "subjectSlug",
            e.status          AS "status",
            e.submitted_at    AS "submittedAt",
            (extract(epoch FROM (now() - e.submitted_at)) / 3600.0) AS "waitingHours",
            (SELECT count(*) FROM evidence_files f WHERE f.evidence_id = e.id AND f.deleted_at IS NULL) AS "fileCount",
            (SELECT count(*) FROM appeals a
               JOIN verifications v ON v.id = a.verification_id
              WHERE v.evidence_id = e.id AND a.status = 'open') AS "openAppeals"
       FROM evidence e
       JOIN evidence_types t ON t.code = e.evidence_type
       LEFT JOIN issuers i       ON i.id = e.issuer_id
       LEFT JOIN profiles pr     ON e.subject_type = 'profile' AND pr.id = e.subject_id
       LEFT JOIN organizations o ON e.subject_type = 'organization' AND o.id = e.subject_id
      WHERE e.status = ANY($1::proof_status[])
        AND ($2::text IS NULL OR e.evidence_type = $2)
      ORDER BY e.submitted_at ASC
      LIMIT $3 OFFSET $4`,
    [statuses, filter.evidenceType ?? null, limit, offset],
  );

  const counts = await q<{ status: string; n: string | number }>(
    `SELECT status::text AS status, count(*) AS n FROM evidence GROUP BY status`,
  );

  // 보안정책 §2 관리자 오남용: 큐 열람도 기록한다. 개인 데이터가 아니므로 목적은 요구하지 않는다.
  await writeAudit(pool(), {
    eventType: "admin.review_queue_viewed",
    actorId: ctx.userId,
    actorRole: p.platformRole,
    aggregateType: "evidence",
    payload: { statuses, evidenceType: filter.evidenceType ?? null, returned: items.length },
    correlationId: ctx.requestId,
  });

  return {
    items: items.map((r) => ({
      evidenceId: r.evidenceId,
      evidenceType: r.evidenceType,
      typeLabelKo: r.typeLabelKo,
      minMethod: r.minMethod,
      requiresIssuer: r.requiresIssuer,
      issuerName: r.issuerName,
      issuerAuthorityChecked: r.issuerAuthorityChecked,
      subjectType: r.subjectType,
      subjectSlug: r.subjectSlug,
      status: r.status,
      submittedAt: isoReq(r.submittedAt),
      waitingHours: Math.round(num(r.waitingHours) * 10) / 10,
      fileCount: num(r.fileCount),
      openAppeals: num(r.openAppeals),
    })),
    countsByStatus: Object.fromEntries(counts.map((c) => [c.status, num(c.n)])),
  };
}

/**
 * P-161~P-165: 증거 상세. **목적 없이 호출되면 거부한다** (기술백서 §5 / 보안정책 §3 접근 제한).
 * 조회 자체가 `audit_logs` 에 목적과 함께 남는다 — 정기 접근검토가 가능해야 하기 때문이다.
 *
 * 여기에는 검증자 내부 메모(`verification_notes`)와 검증자 id 가 들어간다. **검증 콘솔 전용 경로**이고,
 * 당사자 경로는 `proof.getMyEvidence()` 다 — 그 함수는 notes 를 조인하지 않는다 (P-164).
 *
 * `evidence_files.object_key` 는 돌려주지 않는다: 키를 알면 서명만으로 열리므로
 * 다운로드는 반드시 `proof.downloadFile()`(건별 감사로그 + 60초 서명 URL)을 거쳐야 한다 (N-5 / P-073).
 */
export async function evidenceDetail(ctx: Ctx, evidenceId: string, accessPurpose?: string): Promise<EvidenceDetail> {
  const p = await principalOf(ctx);
  mustCan(p, "evidence.review");
  const purpose = requirePurpose(accessPurpose);

  const e = await one<{
    evidenceId: string;
    evidenceType: string;
    typeLabelKo: string;
    minMethod: VerificationMethod;
    requiresIssuer: boolean;
    defaultTtlDays: number | null;
    badgeLabelKo: string;
    status: ProofStatus;
    sourceType: string;
    sourceReference: string | null;
    claim: Record<string, unknown>;
    submittedAt: Date;
    organizationId: string | null;
    subjectType: "profile" | "organization";
    subjectId: string;
    subjectSlug: string | null;
    subjectName: string | null;
    subjectRegion: string | null;
    issuerId: string | null;
    issuerName: string | null;
    issuerKind: string | null;
    issuerAuthorityCheckedAt: Date | null;
  }>(
    `SELECT e.id::text          AS "evidenceId",
            e.evidence_type     AS "evidenceType",
            t.label_ko          AS "typeLabelKo",
            t.min_method        AS "minMethod",
            t.requires_issuer   AS "requiresIssuer",
            t.default_ttl_days  AS "defaultTtlDays",
            t.badge_label_ko    AS "badgeLabelKo",
            e.status            AS "status",
            e.source_type::text AS "sourceType",
            e.source_reference  AS "sourceReference",
            e.claim             AS "claim",
            e.submitted_at      AS "submittedAt",
            e.organization_id::text AS "organizationId",
            e.subject_type      AS "subjectType",
            e.subject_id::text  AS "subjectId",
            COALESCE(pr.slug, o.slug)         AS "subjectSlug",
            COALESCE(pr.display_name, o.name) AS "subjectName",
            pr.region           AS "subjectRegion",
            i.id::text          AS "issuerId",
            i.name              AS "issuerName",
            i.kind              AS "issuerKind",
            i.authority_checked_at AS "issuerAuthorityCheckedAt"
       FROM evidence e
       JOIN evidence_types t ON t.code = e.evidence_type
       LEFT JOIN issuers i       ON i.id = e.issuer_id
       LEFT JOIN profiles pr     ON e.subject_type = 'profile' AND pr.id = e.subject_id
       LEFT JOIN organizations o ON e.subject_type = 'organization' AND o.id = e.subject_id
      WHERE e.id = $1`,
    [evidenceId],
  );
  if (!e) throw notFound("evidence");

  const files = await q<{
    fileId: string;
    contentType: string;
    byteSize: string;
    sha256: string;
    scanStatus: string;
    uploadedAt: Date;
  }>(
    `SELECT id::text AS "fileId", content_type AS "contentType", byte_size::text AS "byteSize",
            sha256, scan_status AS "scanStatus", uploaded_at AS "uploadedAt"
       FROM evidence_files
      WHERE evidence_id = $1 AND deleted_at IS NULL
      ORDER BY uploaded_at`,
    [evidenceId],
  );

  const verifications = await q<{
    id: string;
    method: VerificationMethod;
    status: ProofStatus;
    scope: string | null;
    reasonCode: string | null;
    policyVersion: string;
    reviewerId: string | null;
    verifiedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  }>(
    `SELECT id::text AS "id", method, status, scope, reason_code AS "reasonCode",
            policy_version AS "policyVersion", reviewer_id::text AS "reviewerId",
            verified_at AS "verifiedAt", expires_at AS "expiresAt", created_at AS "createdAt"
       FROM verifications
      WHERE evidence_id = $1
      ORDER BY created_at DESC, id DESC`,
    [evidenceId],
  );

  const notes = await q<{ id: string; verificationId: string; reviewerId: string; note: string; createdAt: Date }>(
    `SELECT n.id::text AS "id", n.verification_id::text AS "verificationId",
            n.reviewer_id::text AS "reviewerId", n.note, n.created_at AS "createdAt"
       FROM verification_notes n
       JOIN verifications v ON v.id = n.verification_id
      WHERE v.evidence_id = $1
      ORDER BY n.created_at DESC`,
    [evidenceId],
  );

  const appeals = await q<{ id: string; verificationId: string; status: string; createdAt: Date; resolvedAt: Date | null }>(
    `SELECT a.id::text AS "id", a.verification_id::text AS "verificationId", a.status,
            a.created_at AS "createdAt", a.resolved_at AS "resolvedAt"
       FROM appeals a
       JOIN verifications v ON v.id = a.verification_id
      WHERE v.evidence_id = $1
      ORDER BY a.created_at DESC`,
    [evidenceId],
  );

  await writeAudit(pool(), {
    eventType: "admin.evidence_viewed",
    actorId: ctx.userId,
    actorRole: p.platformRole,
    tenantId: e.organizationId,
    aggregateType: "evidence",
    aggregateId: e.evidenceId,
    // 조회 **사실**만 남긴다. claim 본문·파일 내용은 감사로그로 복사하지 않는다 (N-13).
    payload: { evidenceType: e.evidenceType, status: e.status, fileCount: files.length },
    accessPurpose: purpose,
    correlationId: ctx.requestId,
  });

  return {
    evidenceId: e.evidenceId,
    evidenceType: e.evidenceType,
    typeLabelKo: e.typeLabelKo,
    minMethod: e.minMethod,
    requiresIssuer: e.requiresIssuer,
    defaultTtlDays: e.defaultTtlDays,
    badgeLabelKo: e.badgeLabelKo,
    status: e.status,
    sourceType: e.sourceType,
    sourceReference: e.sourceReference,
    claim: e.claim ?? {},
    submittedAt: isoReq(e.submittedAt),
    issuer: e.issuerId
      ? {
          id: e.issuerId,
          name: e.issuerName ?? "",
          kind: e.issuerKind ?? "",
          authorityCheckedAt: iso(e.issuerAuthorityCheckedAt),
        }
      : null,
    subject: {
      type: e.subjectType,
      id: e.subjectId,
      slug: e.subjectSlug,
      displayName: e.subjectName,
      region: e.subjectRegion,
    },
    organizationId: e.organizationId,
    files: files.map((f) => ({
      fileId: f.fileId,
      contentType: f.contentType,
      byteSize: num(f.byteSize),
      sha256: f.sha256,
      scanStatus: f.scanStatus,
      uploadedAt: isoReq(f.uploadedAt),
    })),
    verifications: verifications.map((v) => ({
      id: v.id,
      method: v.method,
      status: v.status,
      scope: v.scope,
      reasonCode: v.reasonCode,
      policyVersion: v.policyVersion,
      reviewerId: v.reviewerId,
      verifiedAt: iso(v.verifiedAt),
      expiresAt: iso(v.expiresAt),
      createdAt: isoReq(v.createdAt),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      verificationId: n.verificationId,
      reviewerId: n.reviewerId,
      note: n.note,
      createdAt: isoReq(n.createdAt),
    })),
    appeals: appeals.map((a) => ({
      id: a.id,
      verificationId: a.verificationId,
      status: a.status,
      createdAt: isoReq(a.createdAt),
      resolvedAt: iso(a.resolvedAt),
    })),
  };
}

/**
 * P-164: 검증자 내부 메모.
 *
 * **이 테이블을 당사자·공개 조회 경로에 넣지 마라.** 이유는 기능이 아니라 검증 품질이다:
 * 메모는 "발급기관 담당자 통화 결과", "같은 서류가 다른 계정에서도 올라옴" 같은 판단 재료이고,
 * 당사자에게 보인다는 걸 알면 검증자는 그런 메모를 더 이상 쓰지 않는다. 그러면 복수 검증자 간
 * 일치율(P-173)과 재심(P-168)의 근거가 사라진다.
 * 당사자에게 전달해야 하는 것은 `verifications.reason_code` 와 통지 문구다.
 */
export async function addReviewerNote(ctx: Ctx, verificationId: string, note: string): Promise<{ noteId: string }> {
  const p = await principalOf(ctx);
  mustCan(p, "evidence.review");
  const text = sanitizeText(note, 4000);
  if (text.length < 2) throw badRequest("note_required", "메모 내용을 입력해야 합니다.");
  if (!ctx.userId) throw unauthorized();

  return tx(async (c) => {
    const v = await one<{ id: string; evidenceId: string }>(
      `SELECT id::text AS "id", evidence_id::text AS "evidenceId" FROM verifications WHERE id = $1`,
      [verificationId],
      c,
    );
    if (!v) throw notFound("verification");

    const row = await one<{ id: string }>(
      `INSERT INTO verification_notes (verification_id, reviewer_id, note) VALUES ($1,$2,$3) RETURNING id::text AS "id"`,
      [v.id, ctx.userId, text],
      c,
    );
    if (!row) throw unavailable("note_insert_failed");

    await writeAudit(c, {
      eventType: "admin.reviewer_note_added",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      aggregateType: "verification",
      aggregateId: v.id,
      // 메모 본문은 감사로그로 복사하지 않는다 — 내부 메모를 두 테이블에 퍼뜨리지 않는다.
      payload: { evidenceId: v.evidenceId, noteId: row.id, length: text.length },
      correlationId: ctx.requestId,
    });
    return { noteId: row.id };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-168 이의제기 처리
// ─────────────────────────────────────────────────────────────────────────────

/** P-168: 이의제기 큐. 기본은 미처리(open)만. */
export async function listAppeals(ctx: Ctx, status: string = "open"): Promise<AppealItem[]> {
  const p = await principalOf(ctx);
  mustCan(p, "evidence.review");

  const rows = await q<{
    appealId: string;
    verificationId: string;
    evidenceId: string;
    evidenceType: string;
    evidenceStatus: ProofStatus;
    verificationStatus: ProofStatus;
    status: string;
    reason: string;
    createdAt: Date;
    resolvedAt: Date | null;
    openHours: string | number;
  }>(
    `SELECT a.id::text   AS "appealId",
            a.verification_id::text AS "verificationId",
            v.evidence_id::text     AS "evidenceId",
            e.evidence_type         AS "evidenceType",
            e.status                AS "evidenceStatus",
            v.status                AS "verificationStatus",
            a.status,
            a.reason,
            a.created_at            AS "createdAt",
            a.resolved_at           AS "resolvedAt",
            (extract(epoch FROM (COALESCE(a.resolved_at, now()) - a.created_at)) / 3600.0) AS "openHours"
       FROM appeals a
       JOIN verifications v ON v.id = a.verification_id
       JOIN evidence e      ON e.id = v.evidence_id
      WHERE ($1::text = 'all' OR a.status = $1)
      ORDER BY a.created_at ASC
      LIMIT 200`,
    [status],
  );

  return rows.map((r) => ({
    appealId: r.appealId,
    verificationId: r.verificationId,
    evidenceId: r.evidenceId,
    evidenceType: r.evidenceType,
    evidenceStatus: r.evidenceStatus,
    verificationStatus: r.verificationStatus,
    status: r.status,
    reason: r.reason,
    createdAt: isoReq(r.createdAt),
    resolvedAt: iso(r.resolvedAt),
    openHours: Math.round(num(r.openHours) * 10) / 10,
  }));
}

/**
 * P-168: 이의제기 처리. 결과와 사유를 남기고 **번복률 집계가 가능하게** `appeals.status` 에 결과를 기록한다
 * (upheld = 원 결정 유지 / overturned = 번복). 보안정책 §4.6·§4.7.
 *
 * 재심은 `proof.transition()` 으로만 한다 — 여기서 `verifications` 를 직접 쓰면 N-1 관문을 우회하는
 * 두 번째 경로가 생긴다. 기본 목표 상태:
 *   - overturned → `under_review` (재심 경로). 강도·범위를 갖춰 바로 `verified|rejected` 로 보낼 수도 있다.
 *   - upheld     → 분쟁 전 결정을 그대로 복원 (그 결정의 강도·범위·사유 코드를 다시 적용).
 *
 * 순서: **(1) 전이 가능성 사전검사 → (2) 이의제기 행 선점(CAS) → (3) 전이 실행.**
 * 선점을 먼저 하는 이유는 두 검증자가 같은 이의제기를 동시에 처리하는 것을 막기 위함이고,
 * 사전검사를 그 앞에 두는 이유는 "이의제기는 처리됐는데 상태는 안 바뀐" 창을 거의 0 으로 줄이기 위함이다.
 */
export async function resolveAppeal(
  ctx: Ctx,
  appealId: string,
  outcome: AppealOutcome,
  resolution: string,
  decision: AppealDecision = {},
): Promise<{ appealId: string; outcome: AppealOutcome; evidenceStatus: ProofStatus; verificationId: string | null }> {
  const p = await principalOf(ctx);
  mustCan(p, "evidence.review");
  if (outcome !== "upheld" && outcome !== "overturned") {
    throw badRequest("outcome_invalid", "처리 결과는 upheld 또는 overturned 여야 합니다.");
  }
  const text = sanitizeText(resolution, 2000);
  if (text.length < 5) throw badRequest("resolution_required", "처리 사유를 입력해야 합니다.");
  if (!ctx.userId) throw unauthorized();

  const a = await one<{
    appealId: string;
    status: string;
    verificationId: string;
    evidenceId: string;
    evidenceStatus: ProofStatus;
    minMethod: VerificationMethod;
    requiresIssuer: boolean;
    issuerAuthorityChecked: boolean;
  }>(
    `SELECT a.id::text AS "appealId",
            a.status,
            a.verification_id::text AS "verificationId",
            v.evidence_id::text     AS "evidenceId",
            e.status                AS "evidenceStatus",
            t.min_method            AS "minMethod",
            t.requires_issuer       AS "requiresIssuer",
            (i.authority_checked_at IS NOT NULL) AS "issuerAuthorityChecked"
       FROM appeals a
       JOIN verifications v  ON v.id = a.verification_id
       JOIN evidence e       ON e.id = v.evidence_id
       JOIN evidence_types t ON t.code = e.evidence_type
       LEFT JOIN issuers i   ON i.id = e.issuer_id
      WHERE a.id = $1`,
    [appealId],
  );
  if (!a) throw notFound("appeal");
  if (a.status !== "open") throw conflict("appeal_not_open", "이미 처리된 이의제기입니다.");

  // 분쟁 전의 확정 결정. upheld 복원과 "원래 무슨 결정이었나"의 근거가 된다.
  const prior = await one<{
    method: VerificationMethod;
    status: ProofStatus;
    scope: string | null;
    reasonCode: string | null;
    expiresAt: Date | null;
  }>(
    `SELECT method, status, scope, reason_code AS "reasonCode", expires_at AS "expiresAt"
       FROM verifications
      WHERE evidence_id = $1 AND status IN ('verified','rejected')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [a.evidenceId],
  );

  // ── 목표 상태와 전이 입력을 정한다 ────────────────────────────────────────────
  let to: ProofStatus | null = null;
  let method: VerificationMethod | undefined = decision.method;
  let scope: string | null | undefined = decision.scope;
  let reasonCode: string | null | undefined = decision.reasonCode;
  let expiresAt: Date | null | undefined = decision.expiresAt;

  if (a.evidenceStatus === "disputed") {
    if (outcome === "overturned") {
      to = decision.to ?? "under_review";
    } else {
      // 원 결정 유지. 복원할 결정이 없으면 재검토로 보낸다(분쟁 상태로 방치하지 않는다 — N-14 라벨이 계속 "확인 필요"다).
      to = decision.to ?? prior?.status ?? "under_review";
      if (!decision.method) method = prior?.method;
      if (decision.scope === undefined) scope = prior?.scope ?? null;
      if (decision.reasonCode === undefined) reasonCode = prior?.reasonCode ?? null;
      if (decision.expiresAt === undefined) expiresAt = prior?.expiresAt ?? null;
    }
  }

  // 사전검사: 같은 입력으로 `proof.transition()` 이 통과할지 순수 함수로 먼저 본다 (I/O 없음).
  if (to) {
    const verdict = canTransition({
      from: a.evidenceStatus,
      to,
      actor: "reviewer",
      method: method ?? "self_declared",
      scope,
      reasonCode,
      minMethod: a.minMethod,
      requiresIssuer: a.requiresIssuer,
      issuerAuthorityChecked: a.issuerAuthorityChecked,
    });
    if (!verdict.ok) throw badRequest(verdict.code, verdict.message);
  }

  // ── (2) 선점 ────────────────────────────────────────────────────────────────
  const claimed = await tx(async (c) => {
    const row = await one<{ id: string }>(
      `UPDATE appeals
          SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id::text AS "id"`,
      [a.appealId, outcome, text, ctx.userId],
      c,
    );
    if (!row) throw conflict("appeal_not_open", "이미 처리된 이의제기입니다.");

    await writeAudit(c, {
      eventType: "admin.appeal_resolved",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      aggregateType: "appeal",
      aggregateId: a.appealId,
      payload: {
        outcome,
        verificationId: a.verificationId,
        evidenceId: a.evidenceId,
        from: a.evidenceStatus,
        to,
        priorStatus: prior?.status ?? null,
      },
      correlationId: ctx.requestId,
    });
    return row.id;
  });

  // ── (3) 재심 결정 ──────────────────────────────────────────────────────────
  let evidenceStatus = a.evidenceStatus;
  let verificationId: string | null = null;
  if (to) {
    const outcomeRow = await transition(ctx, a.evidenceId, to, { method, scope, reasonCode, expiresAt, message: text });
    evidenceStatus = outcomeRow.to;
    verificationId = outcomeRow.verificationId;
  }

  return { appealId: claimed, outcome, evidenceStatus, verificationId };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-167 / P-170 신고
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-167: 신고 접수.
 *
 * **여기만 플랫폼 능력을 요구하지 않는다.** 신고는 일반 사용자 경로이고, `report.handle` 을
 * 요구하면 신고 큐에 아무것도 들어오지 못한다(그러면 처리 기능 전체가 의미를 잃는다).
 * 대신 로그인과 rate limit 으로 남용을 막는다 (보안정책 §2 스팸).
 */
export async function createReport(ctx: Ctx, input: CreateReportInput): Promise<{ reportId: string }> {
  if (!ctx.userId) throw unauthorized();
  if (!REPORT_SUBJECTS.includes(input.subjectType)) {
    throw badRequest("subject_type_invalid", "신고 대상 유형이 올바르지 않습니다.");
  }
  const reasonCode = requireReasonCode(input.reasonCode);
  const detail = input.detail ? sanitizeText(input.detail, 2000) : null;
  // TODO(P-189): `RATE_LIMITS` 에 'report.create' 가 없어 도메인 기본값(30/분)으로 판정된다.
  //   한도값은 `packages/domain/src/rateLimit.ts` 담당이 추가한다 — 여기서 고치지 않는다.
  await consumeLimit("report.create", ctx.userId);

  return tx(async (c) => {
    const row = await one<{ id: string }>(
      `INSERT INTO reports (subject_type, subject_id, reporter_id, reason_code, detail)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id::text AS "id"`,
      [input.subjectType, input.subjectId, ctx.userId, reasonCode, detail],
      c,
    );
    if (!row) throw unavailable("report_insert_failed");

    await writeAudit(c, {
      eventType: "report.created",
      actorId: ctx.userId,
      actorRole: "user",
      aggregateType: "report",
      aggregateId: row.id,
      payload: { subjectType: input.subjectType, subjectId: input.subjectId, reasonCode },
      correlationId: ctx.requestId,
    });
    await enqueue(c, {
      eventType: "report.created",
      aggregateType: "report",
      aggregateId: row.id,
      actorId: ctx.userId,
      correlationId: ctx.requestId,
      // 신고 본문은 이벤트로 내보내지 않는다 — 알림 소비자는 "검증 콘솔에서 확인하세요"만 보낸다 (N-13).
      payload: { subjectType: input.subjectType, reasonCode },
    });
    return { reportId: row.id };
  });
}

/** P-167: 신고 큐. 접수·처리 상태와 처리 시간을 함께 돌려준다. */
export async function reportQueue(ctx: Ctx, status: string = "open"): Promise<ReportItem[]> {
  const p = await principalOf(ctx);
  mustCan(p, "report.handle");

  const rows = await q<{
    reportId: string;
    subjectType: ReportSubject;
    subjectId: string;
    reasonCode: string;
    detail: string | null;
    status: string;
    createdAt: Date;
    handledAt: Date | null;
    openHours: string | number;
  }>(
    `SELECT id::text AS "reportId", subject_type AS "subjectType", subject_id::text AS "subjectId",
            reason_code AS "reasonCode", detail, status,
            created_at AS "createdAt", handled_at AS "handledAt",
            (extract(epoch FROM (COALESCE(handled_at, now()) - created_at)) / 3600.0) AS "openHours"
       FROM reports
      WHERE ($1::text = 'all' OR status = $1)
      ORDER BY created_at ASC
      LIMIT 200`,
    [status],
  );

  return rows.map((r) => ({
    reportId: r.reportId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    reasonCode: r.reasonCode,
    detail: r.detail,
    status: r.status,
    createdAt: isoReq(r.createdAt),
    handledAt: iso(r.handledAt),
    openHours: Math.round(num(r.openHours) * 10) / 10,
  }));
}

/**
 * P-167/P-170: 신고 처리. **조치와 사유를 감사로그에 남긴다** — 그것이 P-170 의 수용기준이다.
 *
 * 이 함수는 대상 리소스를 직접 고치지 않는다. 비공개 처리(프로필 발행 취소)는 `profile` 모듈,
 * 배지 취소는 `proof.revokeBadge()` 가 담당한다 (전략 §3: 모듈은 다른 모듈의 테이블을 쓰지 않는다).
 * 신고 처리는 **결정과 기록**이고, 집행은 그 결정을 근거로 담당 모듈에서 수행한다.
 */
export async function handleReport(
  ctx: Ctx,
  reportId: string,
  action: ReportAction,
  reason: string,
): Promise<{ reportId: string; status: string }> {
  const p = await principalOf(ctx);
  mustCan(p, "report.handle");
  if (!REPORT_ACTIONS.includes(action)) throw badRequest("action_invalid", "처리 동작이 올바르지 않습니다.");
  const text = sanitizeText(reason, 1000);
  if (text.length < 3) throw badRequest("reason_required", "처리 사유를 입력해야 합니다.");
  if (!ctx.userId) throw unauthorized();

  return tx(async (c) => {
    const row = await one<{ id: string; subjectType: ReportSubject; subjectId: string; status: string }>(
      `UPDATE reports
          SET status = $2,
              handled_by = $3,
              -- in_review 는 "처리 시작"이므로 처리 완료 시각을 찍지 않는다. SLA 집계가 왜곡된다.
              handled_at = CASE WHEN $2 IN ('actioned','dismissed') THEN now() ELSE handled_at END
        WHERE id = $1 AND status <> $2
        RETURNING id::text AS "id", subject_type AS "subjectType", subject_id::text AS "subjectId", status`,
      [reportId, action, ctx.userId],
      c,
    );
    if (!row) {
      const exists = await one<{ id: string }>(`SELECT id::text AS "id" FROM reports WHERE id = $1`, [reportId], c);
      if (!exists) throw notFound("report");
      throw conflict("report_state_unchanged", "이미 같은 상태입니다.");
    }

    await writeAudit(c, {
      eventType: "admin.report_handled",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      aggregateType: "report",
      aggregateId: row.id,
      payload: { action, subjectType: row.subjectType, subjectId: row.subjectId, reason: text },
      correlationId: ctx.requestId,
    });
    return { reportId: row.id, status: row.status };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-166 감사로그 조회 (N-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-166: 감사로그 조회. **읽기만 한다** — `audit_logs` 는 append-only 이고(N-7),
 * BEFORE UPDATE/DELETE 트리거가 수정·삭제를 예외로 거부한다. 그래서 이 모듈에는 그 SQL이 없다.
 *
 * 조회 자체도 한 줄 남긴다: 감사로그를 누가 들여다봤는지가 정기 접근검토의 대상이다 (보안정책 §2).
 */
export async function auditTrail(
  ctx: Ctx,
  aggregateType: string,
  aggregateId?: string | null,
  limit?: number,
): Promise<AuditEntry[]> {
  const p = await principalOf(ctx);
  mustCan(p, "audit.read");

  const rows = await q<{
    id: string;
    eventType: string;
    actorId: string | null;
    actorRole: string | null;
    tenantId: string | null;
    aggregateType: string;
    aggregateId: string | null;
    payload: Record<string, unknown>;
    accessPurpose: string | null;
    correlationId: string | null;
    occurredAt: Date;
  }>(
    `SELECT id::text AS "id", event_type AS "eventType", actor_id::text AS "actorId", actor_role AS "actorRole",
            tenant_id::text AS "tenantId", aggregate_type AS "aggregateType", aggregate_id::text AS "aggregateId",
            payload_minimized AS "payload", access_purpose AS "accessPurpose",
            correlation_id AS "correlationId", occurred_at AS "occurredAt"
       FROM audit_logs
      WHERE aggregate_type = $1
        AND ($2::uuid IS NULL OR aggregate_id = $2::uuid)
      ORDER BY occurred_at DESC, id DESC
      LIMIT $3`,
    [aggregateType, aggregateId ?? null, clampLimit(limit, 100, 500)],
  );

  await writeAudit(pool(), {
    eventType: "admin.audit_viewed",
    actorId: ctx.userId,
    actorRole: p.platformRole,
    aggregateType,
    aggregateId: aggregateId ?? null,
    payload: { returned: rows.length },
    correlationId: ctx.requestId,
  });

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    actorId: r.actorId,
    actorRole: r.actorRole,
    tenantId: r.tenantId,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    payload: r.payload ?? {},
    accessPurpose: r.accessPurpose,
    correlationId: r.correlationId,
    occurredAt: isoReq(r.occurredAt),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// P-171 권한 변경
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-171: 플랫폼 역할 변경. M01 수용기준 "**관리자 권한 변경이 감사로그에 남는다**".
 *
 * 두 가지를 더 막는다:
 *  1) `admin.access` 는 `acl.ts` 에서 reviewer 에게도 열려 있다. 역할 **부여**는 admin 만 할 수 있어야 하므로
 *     능력 검사 뒤에 플랫폼 역할을 한 번 더 본다 (보안정책 §2 "관리자 권한 상승").
 *  2) 자기 자신의 역할은 바꿀 수 없다 — 권한 상승의 가장 짧은 경로이고, 2인 규칙의 최소 형태다.
 *
 * TODO(M01): 역할을 내릴 때 해당 사용자의 세션을 무효화해야 한다(P-003). 세션 테이블은 identity 모듈 소관이다.
 */
export async function setPlatformRole(ctx: Ctx, userId: string, role: PlatformRole): Promise<{ userId: string; from: PlatformRole; to: PlatformRole }> {
  const p = await principalOf(ctx);
  mustCan(p, "admin.access");
  if (p.platformRole !== "admin") throw forbidden("플랫폼 관리자만 권한을 변경할 수 있습니다.");
  if (!PLATFORM_ROLES.includes(role)) throw badRequest("role_invalid", "권한 값이 올바르지 않습니다.");
  if (!ctx.userId) throw unauthorized();
  if (userId === ctx.userId) throw forbidden("자신의 권한은 변경할 수 없습니다.");

  return tx(async (c) => {
    const before = await one<{ platformRole: PlatformRole }>(
      `SELECT platform_role AS "platformRole" FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [userId],
      c,
    );
    if (!before) throw notFound("user");
    if (before.platformRole === role) throw conflict("role_unchanged", "이미 같은 권한입니다.");

    await c.query(`UPDATE users SET platform_role = $2 WHERE id = $1`, [userId, role]);
    await writeAudit(c, {
      eventType: "admin.platform_role_changed",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      aggregateType: "user",
      aggregateId: userId,
      payload: { from: before.platformRole, to: role },
      correlationId: ctx.requestId,
    });
    return { userId, from: before.platformRole, to: role };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-172 운영 KPI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-172: 운영 KPI (로드맵 §3).
 *
 * 모든 수치에 **집계 기간**이 붙는다. 기간 없는 "검증 완료율 92%"는 N-8 이 공개 지표에서 금지하는
 * 바로 그 모양이고, 운영 대시보드에서도 같은 기준을 지킨다 — 분모를 모르면 판단할 수 없다.
 * 시점 집계(배지 현황)는 `asOf` 로 구분한다.
 *
 * 개인 데이터를 돌려주지 않으므로 접근 사유를 요구하지 않는다(모두 집계값이다).
 */
export async function kpiSummary(ctx: Ctx, from: Date, to: Date): Promise<KpiSummary> {
  const p = await principalOf(ctx);
  mustCan(p, "admin.access");
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest("period_invalid", "집계 기간이 올바르지 않습니다.");
  }
  if (to.getTime() <= from.getTime()) throw badRequest("period_order_invalid", "집계 종료가 시작보다 앞설 수 없습니다.");

  const period = { from: from.toISOString(), to: to.toISOString() };
  const params = [from, to];

  const prof = await one<{ publishedTotal: string; publishedInPeriod: string }>(
    `SELECT (SELECT count(*) FROM profiles WHERE published_at IS NOT NULL)::text AS "publishedTotal",
            (SELECT count(*) FROM profiles WHERE published_at >= $1 AND published_at < $2)::text AS "publishedInPeriod"`,
    params,
  );

  const ev = await one<{
    submitted: string;
    verified: string;
    rejected: string;
    pending: string;
    decided: string;
    avgDecisionHours: number | null;
  }>(
    `SELECT count(*)::text AS "submitted",
            count(*) FILTER (WHERE e.status = 'verified')::text AS "verified",
            count(*) FILTER (WHERE e.status = 'rejected')::text AS "rejected",
            count(*) FILTER (WHERE e.status IN ('submitted','under_review','needs_more_info'))::text AS "pending",
            count(*) FILTER (WHERE d.decided_at IS NOT NULL)::text AS "decided",
            avg(extract(epoch FROM (d.decided_at - e.submitted_at)) / 3600.0)::float8 AS "avgDecisionHours"
       FROM evidence e
       LEFT JOIN LATERAL (
         SELECT min(created_at) AS decided_at
           FROM verifications v
          WHERE v.evidence_id = e.id AND v.status IN ('verified','rejected')
       ) d ON true
      WHERE e.submitted_at >= $1 AND e.submitted_at < $2`,
    params,
  );

  // 배지 현황은 시점 집계다. `pastExpiry` 는 저장 상태와 읽기 시점 판정의 간격을 드러낸다 (N-9).
  const badges = await one<{ active: string; expiringSoon30d: string; pastExpiry: string; revoked: string; disputed: string }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::text AS "active",
            count(*) FILTER (WHERE status = 'active' AND expires_at IS NOT NULL
                               AND expires_at > now() AND expires_at <= now() + interval '30 days')::text AS "expiringSoon30d",
            count(*) FILTER (WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now())::text AS "pastExpiry",
            count(*) FILTER (WHERE status = 'revoked')::text AS "revoked",
            count(*) FILTER (WHERE status = 'disputed')::text AS "disputed"
       FROM badges`,
  );

  const appeals = await one<{ created: string; open: string; upheld: string; overturned: string; avgResolutionHours: number | null }>(
    `SELECT count(*)::text AS "created",
            count(*) FILTER (WHERE status = 'open')::text AS "open",
            count(*) FILTER (WHERE status = 'upheld')::text AS "upheld",
            count(*) FILTER (WHERE status = 'overturned')::text AS "overturned",
            avg(extract(epoch FROM (resolved_at - created_at)) / 3600.0)::float8 AS "avgResolutionHours"
       FROM appeals
      WHERE created_at >= $1 AND created_at < $2`,
    params,
  );

  const reports = await one<{ created: string; open: string; actioned: string; dismissed: string; avgHandlingHours: number | null }>(
    `SELECT count(*)::text AS "created",
            count(*) FILTER (WHERE status IN ('open','in_review'))::text AS "open",
            count(*) FILTER (WHERE status = 'actioned')::text AS "actioned",
            count(*) FILTER (WHERE status = 'dismissed')::text AS "dismissed",
            avg(extract(epoch FROM (handled_at - created_at)) / 3600.0)::float8 AS "avgHandlingHours"
       FROM reports
      WHERE created_at >= $1 AND created_at < $2`,
    params,
  );

  // TODO(M09): 조회 이벤트 `kind` 분류는 analytics 모듈 소관이다. 그 이름이 확정되면 LIKE 를 정확한 값으로 바꾼다.
  const conv = await one<{ profileViews: string; leads: string }>(
    `SELECT (SELECT count(*) FROM analytics_events
              WHERE kind LIKE '%view%' AND occurred_at >= $1 AND occurred_at < $2)::text AS "profileViews",
            (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2)::text AS "leads"`,
    params,
  );

  const submitted = num(ev?.submitted);
  const decided = num(ev?.decided);
  const upheld = num(appeals?.upheld);
  const overturned = num(appeals?.overturned);
  const views = num(conv?.profileViews);
  const leads = num(conv?.leads);

  const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

  return {
    period,
    profiles: {
      publishedTotal: num(prof?.publishedTotal),
      publishedInPeriod: num(prof?.publishedInPeriod),
      period,
    },
    evidence: {
      submitted,
      verified: num(ev?.verified),
      rejected: num(ev?.rejected),
      pending: num(ev?.pending),
      decisionRate: ratio(decided, submitted),
      avgDecisionHours: round1(maybeNum(ev?.avgDecisionHours)),
      period,
    },
    badges: {
      active: num(badges?.active),
      expiringSoon30d: num(badges?.expiringSoon30d),
      pastExpiry: num(badges?.pastExpiry),
      revoked: num(badges?.revoked),
      disputed: num(badges?.disputed),
      asOf: new Date().toISOString(),
    },
    appeals: {
      created: num(appeals?.created),
      open: num(appeals?.open),
      upheld,
      overturned,
      overturnRate: ratio(overturned, upheld + overturned),
      avgResolutionHours: round1(maybeNum(appeals?.avgResolutionHours)),
      period,
    },
    reports: {
      created: num(reports?.created),
      open: num(reports?.open),
      actioned: num(reports?.actioned),
      dismissed: num(reports?.dismissed),
      avgHandlingHours: round1(maybeNum(reports?.avgHandlingHours)),
      period,
    },
    conversion: {
      profileViews: views,
      leads,
      viewToLeadRate: ratio(leads, views),
      period,
    },
  };
}
