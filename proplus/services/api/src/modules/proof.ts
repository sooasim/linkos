/**
 * M04 Proof Engine — PROPLUS 의 중심 모듈 (P-050~P-074).
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/
 *   02_모듈명세_제품요구사항.md M04 "수용 기준: 배지마다 issuer, scope, verified_at, status 를
 *     확인할 수 있고 **모든 상태 변경이 감사로그에 남는다**"
 *   04_보안_개인정보_신뢰정책.md §4 (증거 검증 정책 10개 항목) · §2 (증빙 파일 유출)
 *   01_기술백서_시스템아키텍처.md §5 멀티테넌시 · §7 이벤트
 *   proplus/docs/00_DEV_STRATEGY.md §2 비타협 원칙 · §4.2 상태 머신
 *
 * 이 파일이 지키는 비타협 원칙과 그 지점:
 *   N-1  자기기재는 verified 가 될 수 없다        → `transition()` 이 `canTransition()` 을 **먼저** 호출한다.
 *   N-2  배지는 결제로 얻을 수 없다               → 이 파일은 `subscriptions`·`plans` 를 조회하지 않는다.
 *                                                   `proof → billing` import 도 없다 (전략 §3).
 *   N-5  증거 원본과 공개 배지는 분리 저장         → `evidence_files` 는 서명 URL 경로에서만, `badges` 는 공개 뷰에서만.
 *   N-6  검증 상태 변경은 전부 감사로그에          → `verifications` INSERT 의 AFTER 트리거가 남긴다.
 *                                                   이 파일은 **actor 역할**을 담은 한 줄을 추가로 남긴다.
 *   N-8  지표는 기간·분모·근거 없이 저장 불가      → `validateMetricClaim()` + DB NOT NULL + 트리거.
 *   N-9  만료는 읽기 시점 판정                    → `listBadges()` 는 `public_badge_view` + `toPublicBadges(now)`.
 *   N-13 로그·이벤트에 PII 원문 금지              → payload 에 식별자만. 파일명은 **저장하지 않는다**(아래 attachFile).
 *   N-14 분쟁 중 확정적 표현 금지                 → 공개 라벨 치환은 domain `toPublicBadge()` 가 한다.
 *
 * 권한 원칙(전략 §3): 이 모듈은 권한을 **계산하지 않는다.** 누가 무엇을 할 수 있는지는 domain 의
 * `can()`/`assertCan()` 이 결정하고, 그 입력인 Principal 과 "이 증거의 주인이 누구인가"는
 * 호출부가 아니라 **DB 사실**에서 조립한다. 호출부가 actor 를 고를 수 있으면 N-1 은 장식이 된다.
 */

import { createHash } from "node:crypto";
import {
  assertCan,
  assertNoPrivateKeys,
  canIssueBadge,
  canTransition,
  computeExpiry,
  EVIDENCE_MIME,
  findForbiddenClaim,
  formatMetricDisclosure,
  generateToken,
  hashToken,
  isExpiringSoon,
  isOrgManager,
  isVerifiableMetric,
  MAX_EVIDENCE_BYTES,
  sanitizeText,
  toPublicBadges,
  validateMetricClaim,
  validateUpload,
  type BadgeRow,
  type Capability,
  type EvidenceSource,
  type MemberRole,
  type MetricClaimInput,
  type PlatformRole,
  type Principal,
  type ProofActor,
  type ProofStatus,
  type ProplusEvent,
  type PublicBadge,
  type VerificationMethod,
} from "@proplus/domain";
import type { PoolClient } from "pg";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, pool, q, tx, type Db } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { log } from "../lib/log";
import { enqueue } from "../lib/outbox";
import { getSignedUrl, putObject, SIGNED_URL_TTL_SEC } from "../lib/storage";

// ─────────────────────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 한 증거에 붙일 수 있는 파일 수. 문서에 수치가 없으므로 제품 결정이 아니라 **남용 방지 한도**로 둔다
 * (업로드 1건 한도는 보안정책 §2 의 `MAX_EVIDENCE_BYTES` 가 담당한다).
 */
export const MAX_FILES_PER_EVIDENCE = 10;

/** 증거 파일을 더 받을 수 있는 상태. 확정(verified/rejected) 뒤에 원본이 바뀌면 검증 기록의 의미가 사라진다. */
const FILE_UPLOADABLE: readonly ProofStatus[] = ["submitted", "under_review", "needs_more_info"];

/**
 * 사유 코드의 모양만 제한한다. **코드 목록을 여기서 정의하지 않는다** —
 * 반려 사유 분류는 파일럿 직군이 정해진 뒤 운영이 채우는 값이다(미결정 §2 / 전략 §8).
 * 자유 문장이 코드 컬럼에 들어가는 것만 막는다(집계가 깨지고, 당사자 노출 문구가 섞인다).
 */
const REASON_CODE_RE = /^[a-z][a-z0-9_.:-]{1,59}$/;

/** claim(사용자가 주장하는 내용)의 평탄한 키 상한. 중첩 구조는 받지 않는다 — 아래 sanitizeClaim 참조. */
const MAX_CLAIM_KEYS = 24;

/**
 * 기술백서 §7 이벤트 카탈로그에 **있는** 상태만 이벤트를 만든다.
 * `submitted`·`under_review`·`needs_more_info`·`rejected`·`disputed` 는 카탈로그에 대응 이벤트가 없다 —
 * 없는 이름을 발행하면 `buildEnvelope()` 가 던지고, 있는 것처럼 새 이름을 만들면 구독자 없는 이벤트가 쌓인다.
 * 그 상태들의 당사자 통지는 `notifications` 로 직접 처리한다(P-162/P-163).
 */
const EVENT_FOR_STATUS: Partial<Record<ProofStatus, ProplusEvent>> = {
  verified: "verification.completed",
  expired: "verification.expired",
  revoked: "verification.revoked",
};

/** 전이 뒤 공개 배지를 어떤 상태로 맞출지 (N-9: 만료·취소·분쟁은 즉시 공개에 반영된다). */
const BADGE_STATUS_FOR_STATUS: Partial<Record<ProofStatus, "expired" | "revoked" | "disputed">> = {
  expired: "expired",
  revoked: "revoked",
  // 재심에서 반려로 뒤집힌 경우. 공개 뷰에서 즉시 내려가야 한다.
  rejected: "revoked",
  // N-14: 상태만 바꾸고 라벨은 domain 이 "확인 필요"로 치환한다.
  disputed: "disputed",
};

// ─────────────────────────────────────────────────────────────────────────────
// 내부 타입
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceContext {
  id: string;
  subjectType: "profile" | "organization";
  subjectId: string;
  organizationId: string | null;
  evidenceType: string;
  issuerId: string | null;
  issuerName: string | null;
  issuerAuthorityChecked: boolean;
  sourceType: EvidenceSource;
  status: ProofStatus;
  claim: Record<string, unknown>;
  submittedAt: Date;
  /** evidence_types.min_method — 이 유형이 verified 로 가기 위해 필요한 최소 강도. */
  minMethod: VerificationMethod;
  requiresIssuer: boolean;
  badgeLabelKo: string;
  defaultTtlDays: number | null;
  /** subject_type='profile' 일 때만 채워진다. */
  profileId: string | null;
  ownerUserId: string | null;
}

interface VerificationSnapshot {
  id: string;
  method: VerificationMethod;
  status: ProofStatus;
  scope: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  reasonCode: string | null;
  createdAt: Date;
}

export interface EvidenceTypeDto {
  code: string;
  labelKo: string;
  minMethod: VerificationMethod;
  badgeLabelKo: string;
  requiresIssuer: boolean;
  defaultTtlDays: number | null;
}

export interface SubmitEvidenceInput {
  subjectType?: "profile" | "organization";
  /** 생략하면 "내 프로필". 지정하면 **소유권을 DB 로 확인한 뒤** 쓴다 (IDOR 차단). */
  subjectId?: string;
  evidenceType: string;
  issuerId?: string | null;
  sourceType: EvidenceSource;
  sourceReference?: string | null;
  /** 보안정책 §4.3 의 "범위". 제출 시점에는 주장이므로 claim 안에 들어간다. */
  scope?: string | null;
  claim?: Record<string, unknown>;
  /** 소속·제품교육처럼 조직 테넌트에 속한 증거 (기술백서 §5). 활성 소속이 있어야 쓸 수 있다. */
  organizationId?: string | null;
}

export interface MyEvidenceDto {
  id: string;
  evidenceType: string;
  typeLabelKo: string;
  subjectType: "profile" | "organization";
  status: ProofStatus;
  sourceType: EvidenceSource;
  issuerName: string | null;
  submittedAt: string;
  fileCount: number;
  /** 최신 검증 결과. **검증자 신원(reviewer_id)과 내부 메모는 당사자에게 내보내지 않는다** (P-164). */
  latest: VerificationSummary | null;
  /**
   * 검증 판정 이력 (오래된 것 → 최신). `getMyEvidence` 에서만 채워지고 목록 조회에서는 빈 배열이다.
   *
   * 왜 이력이 필요한가: 당사자는 "왜 반려됐고 재제출 후 무엇이 달라졌는지" 를 알아야 한다.
   * 최신 1건만 주면 화면이 "검증 이력" 을 그릴 수 없고, 반려 → 재제출 → 확인 흐름이 보이지 않는다.
   * 여기에도 reviewer_id·내부 메모는 넣지 않는다 (P-164).
   */
  history: VerificationSummary[];
}

export interface VerificationSummary {
  /** 이의제기 대상 id (P-063). */
  id: string;
  method: VerificationMethod;
  status: ProofStatus;
  scope: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  reasonCode: string | null;
  createdAt: string | null;
}

export interface UploadSession {
  evidenceId: string;
  /** 서버 경유 업로드 경로. 로컬 드라이버에는 직접 PUT 할 곳이 없다 — 아래 주석 참조. */
  uploadPath: string;
  allowedMimeTypes: string[];
  maxBytes: number;
  remainingFiles: number;
  expiresAt: string;
}

export interface TransitionOptions {
  /** 보안정책 §4.1 검증 강도. verified 로 갈 때는 검증자가 **명시**해야 한다 (기본값은 자기기재다). */
  method?: VerificationMethod;
  /** 보안정책 §4.3 검증 범위. verified 필수. */
  scope?: string | null;
  /** 데이터모델 §4 / P-061 — 반려·취소 필수. */
  reasonCode?: string | null;
  /** 유형 기본 TTL 대신 직접 만료일을 둘 때만. */
  expiresAt?: Date | null;
  /** 당사자 통지에 붙일 안내 문구. N-14: 확정적 비난 표현을 쓰지 않는다. */
  message?: string | null;
}

export interface TransitionOutcome {
  evidenceId: string;
  from: ProofStatus;
  to: ProofStatus;
  verificationId: string;
  badgeId: string | null;
}

export interface MetricClaimDto {
  id: string;
  metricCode: string;
  value: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  basis: string;
  verified: boolean;
  /** N-8: 수치와 **반드시 함께** 그려야 하는 공시 문구. */
  disclosure: string;
}

export interface ExpiringBadge {
  badgeId: string;
  profileId: string;
  /** 알림 대상. 이메일은 돌려주지 않는다 — 워커가 필요할 때 직접 조회한다 (N-13). */
  userId: string;
  badgeType: string;
  publicLabel: string;
  expiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 권한 판단에 쓰는 Principal 을 **DB 사실로** 조립한다 (전략 §3).
 *
 * 왜 세션/요청에서 역할을 받지 않는가: 역할이 요청에 담겨 오면 그 값을 믿는 순간
 * 권한 상승이 입력 검증 문제가 된다. `users.platform_role` 과 `memberships` 가 유일한 출처다.
 *
 * TODO(M01): `identity` 모듈이 안정되면 이 조립을 거기로 옮기고 모듈들이 공유한다.
 *   지금 중복을 두는 이유는 모듈 간 import 순서에 보안 함수가 끌려다니지 않게 하려는 것이다.
 */
async function principalOf(ctx: Ctx, db: Db = pool()): Promise<Principal> {
  if (!ctx.userId) return { userId: null, platformRole: "none", memberships: [] };
  const u = await one<{ platformRole: PlatformRole }>(
    `SELECT platform_role AS "platformRole"
       FROM users
      WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [ctx.userId],
    db,
  );
  // 세션은 살아 있지만 계정이 정지·삭제된 경우. 권한을 "none" 으로 깎는 대신 거부한다.
  if (!u) throw unauthorized("계정을 사용할 수 없습니다.");
  const ms = await q<{ organizationId: string; role: MemberRole; status: string }>(
    `SELECT organization_id::text AS "organizationId", role, status
       FROM memberships
      WHERE user_id = $1`,
    [ctx.userId],
    db,
  );
  return { userId: ctx.userId, platformRole: u.platformRole, memberships: ms };
}

/**
 * domain 의 `assertCan()` 은 `Error('forbidden:<cap>')` 를 던진다. 라우트는 ApiError 만 직렬화하므로
 * 여기서 403 으로 바꾼다 — 안 바꾸면 권한 거부가 500 으로 나가고 P-187(에러 규격)이 깨진다.
 */
function mustCan(p: Principal, cap: Capability, target?: { ownerUserId?: string; organizationId?: string }): void {
  try {
    assertCan(p, cap, target);
  } catch {
    throw forbidden(`권한이 없습니다 (${cap}).`);
  }
}

/** P-169: 검증 레코드는 당시 정책 버전을 참조한다. 정책이 없으면 검증을 **진행하지 않는다**. */
async function currentVerificationPolicy(db: Db): Promise<string> {
  const row = await one<{ version: string }>(
    `SELECT version
       FROM policy_versions
      WHERE kind = 'verification' AND effective_at <= now()
      ORDER BY effective_at DESC
      LIMIT 1`,
    [],
    db,
  );
  if (!row) throw unavailable("policy_version_missing", "검증 정책 버전이 설정되지 않았습니다.");
  return row.version;
}

const EVIDENCE_SELECT = `
  SELECT e.id::text                           AS "id",
         e.subject_type                        AS "subjectType",
         e.subject_id::text                    AS "subjectId",
         e.organization_id::text               AS "organizationId",
         e.evidence_type                       AS "evidenceType",
         e.issuer_id::text                     AS "issuerId",
         i.name                                AS "issuerName",
         (i.authority_checked_at IS NOT NULL)  AS "issuerAuthorityChecked",
         e.source_type                         AS "sourceType",
         e.status                              AS "status",
         e.claim                               AS "claim",
         e.submitted_at                        AS "submittedAt",
         t.min_method                          AS "minMethod",
         t.requires_issuer                     AS "requiresIssuer",
         t.badge_label_ko                      AS "badgeLabelKo",
         t.default_ttl_days                    AS "defaultTtlDays",
         pr.id::text                           AS "profileId",
         pr.user_id::text                      AS "ownerUserId"
    FROM evidence e
    JOIN evidence_types t ON t.code = e.evidence_type
    LEFT JOIN issuers i   ON i.id = e.issuer_id
    LEFT JOIN profiles pr ON e.subject_type = 'profile' AND pr.id = e.subject_id`;

async function loadEvidence(db: Db, evidenceId: string): Promise<EvidenceContext> {
  const row = await one<EvidenceContext>(`${EVIDENCE_SELECT} WHERE e.id = $1`, [evidenceId], db);
  if (!row) throw notFound("evidence");
  return row;
}

async function latestVerification(db: Db, evidenceId: string): Promise<VerificationSnapshot | null> {
  return one<VerificationSnapshot>(
    `SELECT id::text AS "id", method, status, scope,
            verified_at AS "verifiedAt", expires_at AS "expiresAt",
            reason_code AS "reasonCode", created_at AS "createdAt"
       FROM verifications
      WHERE evidence_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [evidenceId],
    db,
  );
}

/**
 * 이 사람이 이 증거에 대해 **어떤 자격으로** 행동하는가. 호출부가 고르지 못한다 (M04 수용기준).
 *
 * 소유자 판정이 둘인 이유: 개인 증거의 주인은 `profiles.user_id` 이고,
 * 조직 증거의 주인은 그 조직의 관리자다 (N-12 — 조직은 개인 프로필을 소유하지 않지만 조직 증거는 소유한다).
 */
function resolveActor(ctx: Ctx, p: Principal, ev: EvidenceContext): ProofActor | null {
  if (!ctx.userId) return null;
  if (ev.subjectType === "profile" && ev.ownerUserId && ev.ownerUserId === ctx.userId) return "owner";
  if (ev.subjectType === "organization" && isOrgManager(p, ev.subjectId)) return "owner";
  if (p.platformRole === "reviewer" || p.platformRole === "admin") return "reviewer";
  return null;
}

function nonEmpty(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function requireReasonCode(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!REASON_CODE_RE.test(v)) {
    throw badRequest("reason_code_invalid", "사유 코드는 소문자·숫자·_.:- 로 된 2~60자 코드여야 합니다.");
  }
  return v;
}

/**
 * claim 은 사용자가 주장하는 내용이고 검증자가 읽는 화면에 그대로 뜬다.
 * 평탄한 객체만 받고 문자열은 `sanitizeText()` 를 통과시킨다 (N-10 과 같은 이유: 렌더러를 믿지 않는다).
 */
function sanitizeClaim(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const keys = Object.keys(input);
  if (keys.length > MAX_CLAIM_KEYS) throw badRequest("claim_too_large", `주장 항목은 ${MAX_CLAIM_KEYS}개 이하여야 합니다.`);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const key = sanitizeText(k, 60);
    if (!key) continue;
    const v = input[k];
    if (typeof v === "string") out[key] = sanitizeText(v, 500);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean" || v === null) out[key] = v;
    else throw badRequest("claim_shape_invalid", "주장 항목은 문자열·숫자·참거짓만 담을 수 있습니다.");
  }
  return out;
}

/**
 * plpgsql `RAISE EXCEPTION` 은 SQLSTATE P0001 로 올라온다. 트리거가 막은 것은 **입력 오류**이므로
 * 500 이 아니라 4xx 로 바꾼다 (P-187). 어떤 트리거였는지는 메시지로 구분한다 —
 * 트리거 이름을 조건에 쓰지 않는 이유는 마이그레이션에서 이름이 바뀔 수 있기 때문이다.
 */
function mapTriggerError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? "");
  if (code === "P0001") {
    if (/system_integrated/.test(msg)) {
      return badRequest("metric_requires_integration", "검증된 거래 수치는 시스템 연동 증거만 근거로 쓸 수 있습니다.");
    }
    if (/자기기재/.test(msg)) {
      return badRequest("self_declared_cannot_verify", "자기기재 항목은 배지를 받을 수 없습니다.");
    }
    if (/verified/.test(msg)) {
      return badRequest("not_verified", "검증이 완료되지 않았습니다.");
    }
  }
  if (code === "23505") return conflict("badge_already_active", "같은 유형의 활성 배지가 이미 있습니다.");
  return e;
}

/** 같은 알림을 두 번 넣지 않는다 (P-184). 워커의 notifyOnce 와 같은 dedupe 키를 쓴다. */
async function notifyOnce(
  c: PoolClient,
  userId: string,
  n: { kind: string; title: string; body?: string | null; link: string },
): Promise<void> {
  await c.query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT $1,$2,$3,$4,$5
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id=$1 AND kind=$2 AND link=$5)`,
    [userId, n.kind, n.title, n.body ?? null, n.link],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-050 증거 유형
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-050: 증거 유형 목록. 코드 enum 이 아니라 참조 테이블이므로 마이그레이션 없이 유형이 늘어난다
 * (첫 파일럿 직군 미정 — 미결정 §2).
 *
 * 인증을 요구하지 않는다: 개인정보가 없고, 제출 폼과 공개 배지 설명 패널(P-069)이 같은 목록을 쓴다.
 */
export async function listEvidenceTypes(): Promise<EvidenceTypeDto[]> {
  return q<EvidenceTypeDto>(
    `SELECT code,
            label_ko         AS "labelKo",
            min_method       AS "minMethod",
            badge_label_ko   AS "badgeLabelKo",
            requires_issuer  AS "requiresIssuer",
            default_ttl_days AS "defaultTtlDays"
       FROM evidence_types
      WHERE active
      ORDER BY code`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-051 증거 제출
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-051: 증거 제출. 항상 `status='submitted'` 로 시작한다 — 제출자가 시작 상태를 고를 수 없다.
 *
 * 소유권을 입력으로 믿지 않는다: `subjectId` 가 와도 "내 프로필인지"를 DB 에서 다시 확인한다.
 * 조직 증거는 해당 조직의 관리자만 올린다 (P-083).
 */
export async function submitEvidence(ctx: Ctx, input: SubmitEvidenceInput): Promise<{ evidenceId: string; status: ProofStatus }> {
  if (!ctx.userId) throw unauthorized();
  const p = await principalOf(ctx);
  mustCan(p, "evidence.submit", { ownerUserId: ctx.userId });
  // 보안정책 §2 스팸·남용. 검토 큐를 사람이 처리하므로 제출 빈도 한도가 운영 보호장치다.
  await consumeLimit("evidence.submit", ctx.userId);

  const subjectType = input.subjectType ?? "profile";
  const type = await one<{ code: string; requiresIssuer: boolean }>(
    `SELECT code, requires_issuer AS "requiresIssuer" FROM evidence_types WHERE code = $1 AND active`,
    [input.evidenceType],
  );
  if (!type) throw badRequest("evidence_type_unknown", "증거 유형이 올바르지 않습니다.");

  let subjectId: string;
  let organizationId: string | null = null;

  if (subjectType === "profile") {
    const mine = await one<{ id: string }>(`SELECT id::text AS "id" FROM profiles WHERE user_id = $1`, [ctx.userId]);
    if (!mine) throw badRequest("profile_required", "먼저 프로필을 만들어야 합니다.");
    if (input.subjectId && input.subjectId !== mine.id) throw forbidden("내 프로필의 증거만 제출할 수 있습니다.");
    subjectId = mine.id;
    // 기술백서 §5: 소속·제품교육 증거는 조직 테넌트에 속한다. 활성 소속이 없으면 그 조직을 붙일 수 없다.
    if (nonEmpty(input.organizationId)) {
      const member = p.memberships.some((m) => m.organizationId === input.organizationId && m.status === "active");
      if (!member) throw forbidden("해당 조직의 활성 소속이 아닙니다.");
      organizationId = input.organizationId;
    }
  } else {
    if (!nonEmpty(input.subjectId)) throw badRequest("subject_required", "조직을 지정해야 합니다.");
    // N-12: 조직 리소스는 조직 관리자만 다룬다.
    mustCan(p, "org.manage", { organizationId: input.subjectId });
    subjectId = input.subjectId;
    organizationId = input.subjectId;
  }

  if (nonEmpty(input.issuerId)) {
    const issuer = await one<{ id: string }>(`SELECT id::text AS "id" FROM issuers WHERE id = $1`, [input.issuerId]);
    if (!issuer) throw badRequest("issuer_unknown", "발급기관을 찾을 수 없습니다.");
  }

  const claim = sanitizeClaim(input.claim);
  // 제출 시점의 scope 는 **주장**이다. 확정된 범위는 검증자가 verified 전이에서 넣는다 (보안정책 §4.3).
  if (nonEmpty(input.scope)) claim.scope = sanitizeText(input.scope, 200);

  return tx(async (c) => {
    const row = await one<{ id: string }>(
      `INSERT INTO evidence
         (subject_type, subject_id, organization_id, evidence_type, issuer_id, source_type, source_reference, claim, status, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9)
       RETURNING id::text AS "id"`,
      [
        subjectType,
        subjectId,
        organizationId,
        input.evidenceType,
        nonEmpty(input.issuerId) ? input.issuerId : null,
        input.sourceType,
        nonEmpty(input.sourceReference) ? sanitizeText(input.sourceReference, 300) : null,
        JSON.stringify(claim),
        ctx.userId,
      ],
      c,
    );
    if (!row) throw unavailable("evidence_insert_failed");

    await writeAudit(c, {
      eventType: "evidence.submitted",
      actorId: ctx.userId,
      actorRole: "owner",
      tenantId: organizationId,
      aggregateType: "evidence",
      aggregateId: row.id,
      payload: { evidenceType: input.evidenceType, subjectType, sourceType: input.sourceType },
      correlationId: ctx.requestId,
    });
    // P-183: 외부 연동을 유발하는 쓰기는 같은 트랜잭션에서 outbox 에 남는다.
    await enqueue(c, {
      eventType: "evidence.submitted",
      aggregateType: "evidence",
      aggregateId: row.id,
      tenantId: organizationId,
      actorId: ctx.userId,
      correlationId: ctx.requestId,
      payload: { evidenceType: input.evidenceType, subjectType },
    });

    return { evidenceId: row.id, status: "submitted" as ProofStatus };
  });
}

/**
 * 내 증거 목록. **WHERE 에 소유자 조건이 박혀 있다** — 이 함수에 id 를 넘겨 남의 증거를 보는 경로가 없다.
 * `verification_notes` 와 `reviewer_id` 는 조인하지 않는다 (P-164: 당사자 조회 경로에 넣지 않는다).
 */
export async function listMyEvidence(ctx: Ctx): Promise<MyEvidenceDto[]> {
  if (!ctx.userId) throw unauthorized();
  // 붙이는 것은 **상수 문자열**뿐이다 (ADR-007: 값은 전부 $n 바인딩).
  const rows = await q<MyEvidenceRow>(`${MY_EVIDENCE_SQL} ORDER BY e.submitted_at DESC LIMIT 200`, [ctx.userId]);
  return rows.map(toMyEvidenceDto);
}

/** 단건 조회도 같은 소유자 스코프를 쓴다. 없으면 404 — 남의 증거의 **존재 여부**도 알려 주지 않는다. */
export async function getMyEvidence(ctx: Ctx, id: string): Promise<MyEvidenceDto> {
  if (!ctx.userId) throw unauthorized();
  const row = await one<MyEvidenceRow>(`${MY_EVIDENCE_SQL} AND e.id = $2`, [ctx.userId, id]);
  if (!row) throw notFound("evidence");

  // 소유자 스코프를 이미 통과했으므로 evidence_id 로만 이력을 읽어도 안전하다.
  // 목록(listMyEvidence)에서는 이력을 읽지 않는다 — 200건 × N 판정을 전부 내려보낼 이유가 없다.
  const history = await q<{
    id: string;
    method: VerificationMethod;
    status: ProofStatus;
    scope: string | null;
    verifiedAt: Date | null;
    expiresAt: Date | null;
    reasonCode: string | null;
    createdAt: Date;
  }>(
    `SELECT id::text AS "id", method, status, scope,
            verified_at AS "verifiedAt", expires_at AS "expiresAt",
            reason_code AS "reasonCode", created_at AS "createdAt"
       FROM verifications
      WHERE evidence_id = $1
      ORDER BY created_at ASC, id ASC`,
    [id],
  );

  return {
    ...toMyEvidenceDto(row),
    history: history.map((h) => ({
      id: h.id,
      method: h.method,
      status: h.status,
      scope: h.scope,
      verifiedAt: iso(h.verifiedAt),
      expiresAt: iso(h.expiresAt),
      reasonCode: h.reasonCode,
      createdAt: iso(h.createdAt),
    })),
  };
}

interface MyEvidenceRow {
  id: string;
  evidenceType: string;
  typeLabelKo: string;
  subjectType: "profile" | "organization";
  status: ProofStatus;
  sourceType: EvidenceSource;
  issuerName: string | null;
  submittedAt: Date;
  fileCount: string | number;
  vId: string | null;
  vMethod: VerificationMethod | null;
  vStatus: ProofStatus | null;
  vScope: string | null;
  vVerifiedAt: Date | null;
  vExpiresAt: Date | null;
  vReasonCode: string | null;
}

/**
 * 소유자 스코프 한 덩어리. 개인 증거는 `profiles.user_id`, 조직 증거는 활성 관리자 소속으로 묶는다.
 * `ORDER BY` 뒤에 `AND` 를 붙일 수 없으므로 정렬은 호출부 SQL 마지막에 둔다 — 그래서 여기엔 ORDER BY 가 없다.
 */
const MY_EVIDENCE_SQL = `
  SELECT e.id::text        AS "id",
         e.evidence_type   AS "evidenceType",
         t.label_ko        AS "typeLabelKo",
         e.subject_type    AS "subjectType",
         e.status          AS "status",
         e.source_type     AS "sourceType",
         i.name            AS "issuerName",
         e.submitted_at    AS "submittedAt",
         (SELECT count(*) FROM evidence_files f WHERE f.evidence_id = e.id AND f.deleted_at IS NULL) AS "fileCount",
         v.id::text        AS "vId",
         v.method          AS "vMethod",
         v.status          AS "vStatus",
         v.scope           AS "vScope",
         v.verified_at     AS "vVerifiedAt",
         v.expires_at      AS "vExpiresAt",
         v.reason_code     AS "vReasonCode"
    FROM evidence e
    JOIN evidence_types t ON t.code = e.evidence_type
    LEFT JOIN issuers i ON i.id = e.issuer_id
    LEFT JOIN LATERAL (
      -- id 가 필요하다: 이의제기(P-063)는 POST /me/verifications/{id}/appeal 로 **검증 id** 를 보낸다.
      -- 이 컬럼이 없으면 당사자 화면이 이의제기 버튼을 그릴 방법이 없어서 P-063 이 실제로 동작하지 않는다.
      -- 주의: 이 주석은 JS 템플릿 리터럴 안이다. 백틱이나 달러-중괄호를 쓰면 SQL 문자열이 끊긴다.
      SELECT id, method, status, scope, verified_at, expires_at, reason_code
        FROM verifications
       WHERE evidence_id = e.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    ) v ON true
   WHERE (
     (e.subject_type = 'profile' AND e.subject_id IN (SELECT id FROM profiles WHERE user_id = $1))
     OR
     (e.subject_type = 'organization' AND e.subject_id IN (
        SELECT organization_id FROM memberships
         WHERE user_id = $1 AND status = 'active' AND role IN ('manager','owner')))
   )`;

function toMyEvidenceDto(r: MyEvidenceRow): MyEvidenceDto {
  return {
    id: r.id,
    evidenceType: r.evidenceType,
    typeLabelKo: r.typeLabelKo,
    subjectType: r.subjectType,
    status: r.status,
    sourceType: r.sourceType,
    issuerName: r.issuerName,
    submittedAt: iso(r.submittedAt) ?? new Date(0).toISOString(),
    fileCount: Number(r.fileCount ?? 0),
    latest: r.vId && r.vStatus && r.vMethod
      ? {
          // 이의제기 대상 검증 id (P-063). 화면이 이 값으로 `/me/verifications/{id}/appeal` 을 부른다.
          id: r.vId,
          method: r.vMethod,
          status: r.vStatus,
          scope: r.vScope,
          verifiedAt: iso(r.vVerifiedAt),
          expiresAt: iso(r.vExpiresAt),
          reasonCode: r.vReasonCode,
          createdAt: null,
        }
      : null,
    // 목록 조회는 이력을 읽지 않는다. `getMyEvidence` 가 덮어쓴다.
    history: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-052 증거 파일 (N-5 / 보안정책 §2)
// ─────────────────────────────────────────────────────────────────────────────

/** 증거 하나에 대해 소유자/검증자 자격을 확인하고 (증거, 역할)을 돌려준다. 자격이 없으면 404. */
async function authorizeEvidence(ctx: Ctx, evidenceId: string, db: Db = pool()): Promise<{ ev: EvidenceContext; p: Principal; actor: ProofActor }> {
  if (!ctx.userId) throw unauthorized();
  const p = await principalOf(ctx, db);
  const ev = await loadEvidence(db, evidenceId);
  const actor = resolveActor(ctx, p, ev);
  if (!actor) throw notFound("evidence");
  if (actor === "reviewer") mustCan(p, "evidence.review");
  return { ev, p, actor };
}

/**
 * P-052: 업로드 세션. **바이트를 보내기 전에** 유형·상태·형식·크기·개수를 먼저 거절하기 위한 사전검사다.
 *
 * 왜 signed PUT URL 이 아닌가: 지금 스토리지는 로컬 드라이버이고 직접 PUT 할 엔드포인트가 없다
 * (전략 §6 Files — 운영 버킷·키 관리 정책 미정이라 S3 드라이버를 설치하지 않았다).
 * S3 드라이버가 들어오면 이 함수가 presigned PUT URL 을 돌려주고 `attachFile` 은 서버 경유 경로로 남는다 —
 * 호출부 모양을 바꾸지 않으려고 세션을 **지금** 만들어 둔다.
 */
export async function createUploadSession(
  ctx: Ctx,
  evidenceId: string,
  meta: { filename?: string; declaredMime: string; byteSize: number },
): Promise<UploadSession> {
  const { ev, actor } = await authorizeEvidence(ctx, evidenceId);
  // 증거 원본은 당사자가 올린다. 검증자가 남의 증거 파일을 추가하면 "누가 제출했는가"가 흐려진다.
  if (actor !== "owner") throw forbidden("증거 파일은 당사자만 올릴 수 있습니다.");
  if (!FILE_UPLOADABLE.includes(ev.status)) {
    throw badRequest("evidence_not_uploadable", "지금 상태에서는 파일을 추가할 수 없습니다.");
  }
  if (!EVIDENCE_MIME.has((meta.declaredMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "")) {
    throw badRequest("mime_not_allowed", "이미지(JPEG·PNG·WebP) 또는 PDF 만 올릴 수 있습니다.");
  }
  if (!Number.isInteger(meta.byteSize) || meta.byteSize <= 0 || meta.byteSize > MAX_EVIDENCE_BYTES) {
    throw badRequest("file_too_large", `파일은 ${Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024))}MB 이하여야 합니다.`);
  }

  const used = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM evidence_files WHERE evidence_id = $1 AND deleted_at IS NULL`,
    [evidenceId],
  );
  const remaining = MAX_FILES_PER_EVIDENCE - Number(used?.n ?? 0);
  if (remaining <= 0) throw badRequest("too_many_files", `증거당 파일은 ${MAX_FILES_PER_EVIDENCE}개까지입니다.`);

  return {
    evidenceId: ev.id,
    // `/me/` 가 붙는다. 증거 업로드는 **당사자 전용**이라 라우트가 `/api/v1/me/evidence/...` 에 있고
    // (데이터모델 §4 의 `/me/*` 규칙), 여기서 경로를 틀리면 클라이언트가 404 로 업로드를 못 한다.
    uploadPath: `/api/v1/me/evidence/${ev.id}/files`,
    allowedMimeTypes: [...EVIDENCE_MIME],
    maxBytes: MAX_EVIDENCE_BYTES,
    remainingFiles: remaining,
    // 세션은 서버 상태를 만들지 않는다(테이블 추가 금지). 이 값은 "이 사전검사 결과를 믿어도 되는 시간"이다.
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

/**
 * P-052/P-196: 파일을 받아 암호화 저장하고 메타데이터만 DB 에 남긴다 (N-5).
 *
 * 세 가지를 못 박는다:
 *  1) `validateUpload()` 가 선언 MIME 과 **매직바이트**를 함께 본다. 둘이 다르면 거부다(조용히 고치지 않는다).
 *  2) `object_key` 는 추측 불가능한 난수다 — 키를 알면 서명만 있으면 열리므로 순번·파일명을 쓰지 않는다.
 *  3) **파일명을 저장하지 않는다.** "홍길동_주민등록증.pdf" 같은 이름은 그 자체가 민감정보이고
 *     `evidence_files` 에 컬럼도 없다 (N-13). 확장자는 형식 일치 확인에만 쓰고 버린다.
 */
export async function attachFile(
  ctx: Ctx,
  evidenceId: string,
  bytes: Buffer | Uint8Array,
  declaredMime: string,
  filename?: string,
): Promise<{ fileId: string; contentType: string; byteSize: number }> {
  const { ev, actor } = await authorizeEvidence(ctx, evidenceId);
  if (actor !== "owner") throw forbidden("증거 파일은 당사자만 올릴 수 있습니다.");
  if (!FILE_UPLOADABLE.includes(ev.status)) {
    throw badRequest("evidence_not_uploadable", "지금 상태에서는 파일을 추가할 수 없습니다.");
  }
  if (ctx.userId) await consumeLimit("evidence.submit", ctx.userId);

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const verdict = validateUpload(declaredMime, buf.byteLength, buf.subarray(0, 32));
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  // 확장자가 있는데 실제 형식과 어긋나면 거부한다 — 업로더의 착각이든 시도든 검증자가 열기 전에 걸러야 한다.
  const ext = (filename ?? "").toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  if (ext && EXT_FOR_MIME[verdict.mime] && !EXT_FOR_MIME[verdict.mime]?.includes(ext)) {
    throw badRequest("mime_mismatch", "파일 형식이 확장자와 다릅니다.");
  }

  const used = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM evidence_files WHERE evidence_id = $1 AND deleted_at IS NULL`,
    [evidenceId],
  );
  if (Number(used?.n ?? 0) >= MAX_FILES_PER_EVIDENCE) {
    throw badRequest("too_many_files", `증거당 파일은 ${MAX_FILES_PER_EVIDENCE}개까지입니다.`);
  }

  // 키는 소문자 16진수다: storage 의 키 화이트리스트가 대문자를 허용하지 않고(`assertObjectKey`),
  // 난수 자체는 generateToken 이 만든다 — 해시는 인코딩 변환 수단일 뿐 비밀을 더하지 않는다.
  const objectKey = `evidence/${ev.id}/${hashToken(generateToken(32))}`;
  const sha256 = createHash("sha256").update(buf).digest("hex");

  return tx(async (c) => {
    // 먼저 행을 넣고 그 다음 객체를 쓴다: 저장이 실패하면 트랜잭션이 되돌아가 **참조 없는 메타데이터가 남지 않는다.**
    // (반대 순서라면 커밋 실패 시 DB 는 깨끗하지만 암호화된 고아 객체가 남는다 — 그쪽이 덜 위험하다고 볼 수도 있으나,
    //  검증자 화면에 "열 수 없는 파일"이 뜨는 쪽이 운영에 더 나쁘다.)
    const row = await one<{ id: string }>(
      `INSERT INTO evidence_files (evidence_id, object_key, content_type, byte_size, sha256, encryption_ref, scan_status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING id::text AS "id"`,
      [ev.id, objectKey, verdict.mime, buf.byteLength, sha256, null],
      c,
    );
    if (!row) throw unavailable("evidence_file_insert_failed");

    const { encryptionRef } = await putObject(objectKey, buf, verdict.mime);
    await c.query(`UPDATE evidence_files SET encryption_ref = $2 WHERE id = $1`, [row.id, encryptionRef]);

    await writeAudit(c, {
      eventType: "evidence.file.attached",
      actorId: ctx.userId,
      actorRole: "owner",
      tenantId: ev.organizationId,
      aggregateType: "evidence",
      aggregateId: ev.id,
      // 파일명·내용은 남기지 않는다. 동일성 확인에 필요한 것은 해시와 크기다 (N-13).
      payload: { fileId: row.id, contentType: verdict.mime, byteSize: buf.byteLength, sha256 },
      correlationId: ctx.requestId,
    });

    return { fileId: row.id, contentType: verdict.mime, byteSize: buf.byteLength };
  });
}

const EXT_FOR_MIME: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
};

/**
 * P-073: 증거 원본 다운로드. **다운로드마다 감사로그를 남긴다** (보안정책 §2).
 *
 * `accessPurpose` 를 필수로 받는 이유(P-165 / 기술백서 §5 "운영자 접근은 목적·승인·시간 제한·감사로그를 요구한다"):
 * 목적 없는 조회를 허용하면 감사로그가 "누가 열었다"만 남기고 "왜"를 잃는다. 그러면 정기 접근검토가 불가능해진다.
 * 당사자 본인에게도 요구한다 — 증거 원본 접근은 예외 없이 이유가 기록되는 경로여야 한다.
 */
export async function downloadFile(
  ctx: Ctx,
  fileId: string,
  accessPurpose?: string,
): Promise<{ url: string; expiresInSec: number; contentType: string; byteSize: number; scanStatus: string }> {
  if (!ctx.userId) throw unauthorized();
  const purpose = (accessPurpose ?? "").trim();
  if (purpose.length < 3) throw badRequest("access_purpose_required", "조회 목적을 입력해야 합니다.");

  const p = await principalOf(ctx);
  const f = await one<{
    id: string;
    evidenceId: string;
    objectKey: string;
    contentType: string;
    byteSize: string;
    scanStatus: string;
    subjectType: "profile" | "organization";
    subjectId: string;
    organizationId: string | null;
    ownerUserId: string | null;
  }>(
    `SELECT f.id::text              AS "id",
            f.evidence_id::text     AS "evidenceId",
            f.object_key            AS "objectKey",
            f.content_type          AS "contentType",
            f.byte_size::text       AS "byteSize",
            f.scan_status           AS "scanStatus",
            e.subject_type          AS "subjectType",
            e.subject_id::text      AS "subjectId",
            e.organization_id::text AS "organizationId",
            pr.user_id::text        AS "ownerUserId"
       FROM evidence_files f
       JOIN evidence e ON e.id = f.evidence_id
       LEFT JOIN profiles pr ON e.subject_type = 'profile' AND pr.id = e.subject_id
      WHERE f.id = $1 AND f.deleted_at IS NULL`,
    [fileId],
  );
  if (!f) throw notFound("file");

  const isOwner =
    (f.subjectType === "profile" && f.ownerUserId === ctx.userId) ||
    (f.subjectType === "organization" && isOrgManager(p, f.subjectId));
  const isReviewer = p.platformRole === "reviewer" || p.platformRole === "admin";
  if (!isOwner && !isReviewer) throw notFound("file");
  if (!isOwner) mustCan(p, "evidence.review");

  // 보안정책 §2 업로드 악성 파일. 스캐너는 아직 없다(전략 §8) — 'infected' 로 표시된 것만 확실히 막는다.
  if (f.scanStatus === "infected") throw forbidden("이 파일은 제공할 수 없습니다.");

  return tx(async (c) => {
    // 서명 URL 발급과 감사 기록은 **함께 남거나 함께 없어야 한다** (lib/storage.ts 주석과 같은 이유).
    await writeAudit(c, {
      eventType: "evidence.file.downloaded",
      actorId: ctx.userId,
      actorRole: isOwner ? "owner" : p.platformRole,
      tenantId: f.organizationId,
      aggregateType: "evidence_file",
      aggregateId: f.id,
      payload: { evidenceId: f.evidenceId, contentType: f.contentType, byteSize: Number(f.byteSize) },
      accessPurpose: purpose,
      correlationId: ctx.requestId,
    });
    const url = await getSignedUrl(f.objectKey);
    return {
      url,
      expiresInSec: SIGNED_URL_TTL_SEC,
      contentType: f.contentType,
      byteSize: Number(f.byteSize),
      scanStatus: f.scanStatus,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-053 상태 전이 — N-1 의 관문
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-053: 검증 상태 전이. **이 함수가 PROPLUS 의 신뢰 경계다.**
 *
 * 순서가 규칙이다:
 *   1) actor 를 DB 사실로 정한다 (소유자인가 / 플랫폼 검증자인가). 호출부가 고를 수 없다.
 *   2) 검증자 전이는 `evidence.review` 능력을 통과해야 한다.
 *   3) **`canTransition()` 을 먼저** 부르고 실패하면 그 code/message 를 그대로 4xx 로 던진다 (N-1·§4.3·§4.4).
 *   4) 통과한 뒤에만 한 트랜잭션 안에서: verifications INSERT → evidence.status → 배지 → 공개 반영 → outbox.
 *
 * `verifications` INSERT 에 걸린 AFTER 트리거가 감사로그를 남긴다(N-6) — 이 함수가 깜빡해도 기록은 남는다.
 * 그 위에 actor 역할을 담은 한 줄을 더 남긴다: 트리거는 `reviewer_id` 만 아는데, 당사자 철회·시스템 만료는
 * reviewer 가 없어서 "누가 했는지"가 비기 때문이다.
 */
export async function transition(
  ctx: Ctx,
  evidenceId: string,
  to: ProofStatus,
  opts: TransitionOptions = {},
): Promise<TransitionOutcome> {
  // 비로그인 호출을 system 으로 취급하지 않는다. 시스템 전이는 아래 `systemTransition` 뿐이다.
  if (!ctx.userId) throw unauthorized();
  const p = await principalOf(ctx);

  return tx(async (c) => {
    // 같은 증거를 두 검증자가 동시에 승인해 배지가 둘 생기는 것을 DB 락으로 막는다.
    const locked = await one<{ status: ProofStatus }>(`SELECT status FROM evidence WHERE id = $1 FOR UPDATE`, [evidenceId], c);
    if (!locked) throw notFound("evidence");

    const ev = await loadEvidence(c, evidenceId);
    const actor = resolveActor(ctx, p, ev);
    if (!actor) throw notFound("evidence");
    if (actor === "reviewer") mustCan(p, "evidence.review");

    return applyTransition(c, { ctx, ev, actor, actorUserId: ctx.userId, to, opts });
  });
}

/**
 * 시스템 전이 (`verified → expired` 등). **워커 전용**이다 — `systemCtx()` 로 만든 Ctx 만 통과한다.
 *
 * 라우트에서 이 함수를 노출하면 비로그인 요청이 system 자격을 얻는다. 노출하지 마라.
 * (만료 자체는 읽기 시점 판정이 진실이다(N-9). 이 경로는 **이력을 남기기 위한** 전이다.)
 */
export async function systemTransition(
  ctx: Ctx,
  evidenceId: string,
  to: ProofStatus,
  opts: TransitionOptions = {},
): Promise<TransitionOutcome> {
  if (ctx.userId) throw forbidden("시스템 전이는 사용자 자격으로 호출할 수 없습니다.");
  return tx(async (c) => {
    const locked = await one<{ status: ProofStatus }>(`SELECT status FROM evidence WHERE id = $1 FOR UPDATE`, [evidenceId], c);
    if (!locked) throw notFound("evidence");
    const ev = await loadEvidence(c, evidenceId);
    return applyTransition(c, { ctx, ev, actor: "system", actorUserId: null, to, opts });
  });
}

interface ApplyArgs {
  ctx: Ctx;
  ev: EvidenceContext;
  actor: ProofActor;
  actorUserId: string | null;
  to: ProofStatus;
  opts: TransitionOptions;
}

/** 전이의 유일한 쓰기 경로. `transition`·`systemTransition`·`revokeBadge`·관리자 재심이 모두 여기를 지난다. */
async function applyTransition(c: PoolClient, a: ApplyArgs): Promise<TransitionOutcome> {
  const { ctx, ev, actor, to, opts } = a;
  const now = new Date();
  const last = await latestVerification(c, ev.id);

  /**
   * 강도의 기본값이 `self_declared` 인 것이 N-1 을 지키는 방식이다:
   * 검증자가 강도를 **명시하지 않으면** verified 로 갈 수 없다. "모르면 통과"가 아니라 "모르면 자기기재"다.
   */
  const method: VerificationMethod = opts.method ?? last?.method ?? "self_declared";
  const scope = nonEmpty(opts.scope) ? sanitizeText(opts.scope, 200) : null;
  const reasonCode = to === "rejected" || to === "revoked" ? requireReasonCode(opts.reasonCode) : null;

  // ── N-1 의 관문. 통과하지 못하면 아무것도 쓰지 않는다. ──────────────────────────
  const verdict = canTransition({
    from: ev.status,
    to,
    actor,
    method,
    scope,
    reasonCode,
    minMethod: ev.minMethod,
    requiresIssuer: ev.requiresIssuer,
    issuerAuthorityChecked: ev.issuerAuthorityChecked,
  });
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  const verifiedAt = to === "verified" ? now : (last?.verifiedAt ?? null);
  const expiresAt =
    to === "verified" ? (opts.expiresAt ?? computeExpiry(now, ev.defaultTtlDays)) : (last?.expiresAt ?? null);
  const policyVersion = await currentVerificationPolicy(c);

  let verificationId: string;
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO verifications
         (evidence_id, method, reviewer_id, status, scope, verified_at, expires_at, reason_code, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id::text AS "id"`,
      [
        ev.id,
        method,
        // 검증자가 아닌 전이에는 reviewer 가 없다. 당사자 id 를 reviewer_id 에 넣으면
        // "본인이 검토했다"는 거짓 기록이 되므로 비워 두고, actor 는 아래 감사 한 줄이 담는다.
        actor === "reviewer" ? a.actorUserId : null,
        to,
        scope,
        verifiedAt,
        expiresAt,
        reasonCode,
        policyVersion,
      ],
      c,
    );
    if (!row) throw unavailable("verification_insert_failed");
    verificationId = row.id;
  } catch (e) {
    throw mapTriggerError(e);
  }

  await c.query(`UPDATE evidence SET status = $2 WHERE id = $1`, [ev.id, to]);

  // N-9: 공개 배지를 같은 트랜잭션에서 맞춘다. 배치를 기다리는 창을 만들지 않는다.
  let badgeId: string | null = null;
  if (to === "verified") {
    badgeId = await issueBadgeTx(c, {
      ctx,
      ev,
      verificationId,
      method,
      scope: scope ?? "",
      verifiedAt: verifiedAt ?? now,
      expiresAt,
      actorRole: actor,
    });
  } else {
    const badgeStatus = BADGE_STATUS_FOR_STATUS[to];
    if (badgeStatus) await syncBadges(c, ev.id, badgeStatus);
  }

  // P-162/P-163: 반려·추가정보 요청은 당사자에게 알린다. 카탈로그에 대응 이벤트가 없어 알림으로 처리한다.
  if (ev.ownerUserId && actor === "reviewer" && (to === "needs_more_info" || to === "rejected")) {
    await notifyOnce(c, ev.ownerUserId, {
      kind: `evidence.${to}`,
      // N-14: 사실만 적는다. 사유 코드·안내 문구는 워크스페이스에서 보여 준다.
      title: to === "needs_more_info" ? "증거 추가 정보가 필요합니다" : "증거 검토 결과가 등록되었습니다",
      body: nonEmpty(opts.message) ? sanitizeText(opts.message, 300) : "검증 내역에서 확인하세요.",
      link: `/app/evidence/${ev.id}`,
    });
  }

  await writeAudit(c, {
    eventType: "evidence.transitioned",
    actorId: a.actorUserId,
    actorRole: actor,
    tenantId: ev.organizationId,
    aggregateType: "evidence",
    aggregateId: ev.id,
    payload: { from: ev.status, to, method, verificationId, badgeId, reasonCode },
    correlationId: ctx.requestId,
  });

  const eventType = EVENT_FOR_STATUS[to];
  if (eventType) {
    await enqueue(c, {
      eventType,
      aggregateType: "verification",
      aggregateId: verificationId,
      tenantId: ev.organizationId,
      actorId: a.actorUserId,
      correlationId: ctx.requestId,
      payload: { evidenceId: ev.id, evidenceType: ev.evidenceType, method, status: to },
    });
  }

  return { evidenceId: ev.id, from: ev.status, to, verificationId, badgeId };
}

/** 이 증거에서 나온 공개 배지의 상태를 맞춘다 (N-9). 라벨·강도는 손대지 않는다 — 배지의 사실은 그대로다. */
async function syncBadges(c: PoolClient, evidenceId: string, status: "expired" | "revoked" | "disputed"): Promise<void> {
  await c.query(
    `UPDATE badges b
        SET status = $2,
            revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE b.revoked_at END
      WHERE b.verification_id IN (SELECT id FROM verifications WHERE evidence_id = $1)
        AND b.status IN ('active','disputed')`,
    [evidenceId, status],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P-057 / P-061 / P-062 배지
// ─────────────────────────────────────────────────────────────────────────────

interface IssueArgs {
  ctx: Ctx;
  ev: EvidenceContext;
  verificationId: string;
  method: VerificationMethod;
  scope: string;
  verifiedAt: Date;
  expiresAt: Date | null;
  actorRole: string;
}

/**
 * P-057 배지 발급 (N-2 / N-5).
 *
 * **이 함수는 구독·요금제를 조회하지 않는다.** 인자에도 없다 — 그게 N-2 를 코드로 강제하는 방식이다
 * (보안정책 §4.10). 나중에 "Pro 전용 배지"가 필요해지면 이 시그니처를 바꿔야 하고 리뷰가 걸린다.
 *
 * 배지는 `verification` 만 가리킨다. `evidence_files` 를 참조하지 않으므로 공개 조회에 증거 원본이 섞일 길이 없다(N-5).
 */
async function issueBadgeTx(c: PoolClient, a: IssueArgs): Promise<string | null> {
  const { ev } = a;
  // 조직 증거는 개인 배지를 만들지 않는다 (N-12: `badges.profile_id` 는 개인 프로필이다).
  // 조직 소속의 공개 표현은 개인이 올린 affiliation 증거가 담당한다 (P-081~P-084).
  if (ev.subjectType !== "profile" || !ev.profileId) {
    log("info", "proof.badge_skipped_non_profile", { evidenceId: ev.id, subjectType: ev.subjectType });
    return null;
  }

  const verdict = canIssueBadge({
    verificationStatus: "verified",
    method: a.method,
    scope: a.scope,
    verifiedAt: a.verifiedAt,
  });
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  // 브랜드 §5: 근거가 부족하거나 오해를 부르는 표현은 공개 라벨에 쓰지 않는다.
  const forbiddenClaim = findForbiddenClaim(ev.badgeLabelKo);
  if (forbiddenClaim) {
    throw badRequest("forbidden_claim", `배지 라벨에 허용되지 않는 표현이 있습니다: ${forbiddenClaim}`);
  }

  // 발급기관을 요구하는 유형인데 이름이 없으면 공개 6필드가 비어 배지가 숨겨진다(P-058).
  // 그 상태로 발급하면 "발급됐는데 안 보이는 배지"가 되므로 여기서 막는다.
  if (ev.requiresIssuer && !nonEmpty(ev.issuerName)) {
    throw badRequest("issuer_name_required", "발급기관 정보가 없어 배지를 발급할 수 없습니다.");
  }

  // P-062 재검증: 같은 유형의 이전 배지를 먼저 내린다. `badges_active_one_per_type` 부분 UNIQUE 때문이고,
  // 분쟁(disputed) 배지도 공개 뷰에 뜨므로 함께 내린다. **이번 검증의 배지는 제외**한다(재시도 멱등성).
  await c.query(
    `UPDATE badges SET status = 'expired'
      WHERE profile_id = $1 AND badge_type = $2 AND status IN ('active','disputed') AND verification_id <> $3`,
    [ev.profileId, ev.evidenceType, a.verificationId],
  );

  let badgeId: string | null = null;
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO badges
         (profile_id, badge_type, verification_id, public_label, method, scope, issuer_name, status, verified_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)
       ON CONFLICT (verification_id) DO NOTHING
       RETURNING id::text AS "id"`,
      [ev.profileId, ev.evidenceType, a.verificationId, ev.badgeLabelKo, a.method, a.scope, ev.issuerName, a.verifiedAt, a.expiresAt],
      c,
    );
    badgeId = row?.id ?? null;
  } catch (e) {
    throw mapTriggerError(e);
  }

  if (!badgeId) {
    // 이미 이 검증으로 발급된 배지가 있다 (재시도). 되돌려 세우고 끝낸다 — 중복 발급도, 중복 이벤트도 만들지 않는다.
    const existing = await one<{ id: string }>(
      `UPDATE badges SET status = 'active', revoked_at = NULL WHERE verification_id = $1 RETURNING id::text AS "id"`,
      [a.verificationId],
      c,
    );
    return existing?.id ?? null;
  }

  await writeAudit(c, {
    eventType: "badge.issued",
    actorId: a.ctx.userId,
    actorRole: a.actorRole,
    tenantId: ev.organizationId,
    aggregateType: "badge",
    aggregateId: badgeId,
    payload: { profileId: ev.profileId, badgeType: ev.evidenceType, method: a.method, verificationId: a.verificationId },
    correlationId: a.ctx.requestId,
  });
  await enqueue(c, {
    eventType: "badge.issued",
    aggregateType: "badge",
    aggregateId: badgeId,
    tenantId: ev.organizationId,
    actorId: a.ctx.userId,
    correlationId: a.ctx.requestId,
    payload: { profileId: ev.profileId, badgeType: ev.evidenceType, method: a.method },
  });
  return badgeId;
}

/**
 * P-057: 이미 verified 인 검증으로 배지를 (재)발급한다.
 * 정상 경로는 `transition(..., 'verified')` 안에서 자동 발급이고, 이 함수는 **복구용**이다
 * (예: 라벨 수정 뒤 재발급). 구독 상태는 여기서도 보지 않는다 (N-2).
 */
export async function issueBadge(ctx: Ctx, verificationId: string): Promise<{ badgeId: string | null }> {
  if (!ctx.userId) throw unauthorized();
  const p = await principalOf(ctx);
  mustCan(p, "badge.issue");

  return tx(async (c) => {
    const v = await one<{
      id: string;
      evidenceId: string;
      method: VerificationMethod;
      status: ProofStatus;
      scope: string | null;
      verifiedAt: Date | null;
      expiresAt: Date | null;
    }>(
      `SELECT id::text AS "id", evidence_id::text AS "evidenceId", method, status, scope,
              verified_at AS "verifiedAt", expires_at AS "expiresAt"
         FROM verifications WHERE id = $1 FOR UPDATE`,
      [verificationId],
      c,
    );
    if (!v) throw notFound("verification");

    const verdict = canIssueBadge({
      verificationStatus: v.status,
      method: v.method,
      scope: v.scope,
      verifiedAt: v.verifiedAt,
    });
    if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

    const ev = await loadEvidence(c, v.evidenceId);
    const badgeId = await issueBadgeTx(c, {
      ctx,
      ev,
      verificationId: v.id,
      method: v.method,
      scope: v.scope ?? "",
      verifiedAt: v.verifiedAt ?? new Date(),
      expiresAt: v.expiresAt,
      actorRole: p.platformRole,
    });
    return { badgeId };
  });
}

/**
 * P-061: 배지 취소. 사유 코드 필수, 공개 배지 즉시 제거, 감사로그.
 *
 * 배지만 내리지 않고 **검증 자체를 revoked 로 전이**한다 — 배지는 검증의 공개 표현이므로
 * 둘이 갈라지면 "취소된 배지인데 검증은 유효" 같은 상태가 생긴다. 전이는 같은 관문(`canTransition`)을 지난다.
 */
export async function revokeBadge(ctx: Ctx, badgeId: string, reasonCode: string): Promise<TransitionOutcome> {
  if (!ctx.userId) throw unauthorized();
  const code = requireReasonCode(reasonCode);
  const p = await principalOf(ctx);
  mustCan(p, "badge.revoke");

  return tx(async (c) => {
    const b = await one<{ id: string; evidenceId: string; method: VerificationMethod }>(
      `SELECT b.id::text AS "id", v.evidence_id::text AS "evidenceId", b.method
         FROM badges b
         JOIN verifications v ON v.id = b.verification_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [badgeId],
      c,
    );
    if (!b) throw notFound("badge");

    await c.query(`SELECT status FROM evidence WHERE id = $1 FOR UPDATE`, [b.evidenceId]);
    const ev = await loadEvidence(c, b.evidenceId);

    // 전이는 검증자 자격으로만. `badge.revoke` 를 이미 통과했으므로 플랫폼 역할이 확정돼 있다.
    const outcome = await applyTransition(c, {
      ctx,
      ev,
      actor: "reviewer",
      actorUserId: ctx.userId,
      to: "revoked",
      opts: { method: b.method, reasonCode: code },
    });

    await writeAudit(c, {
      eventType: "badge.revoked",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      tenantId: ev.organizationId,
      aggregateType: "badge",
      aggregateId: b.id,
      payload: { reasonCode: code, evidenceId: ev.id, verificationId: outcome.verificationId },
      correlationId: ctx.requestId,
    });
    return outcome;
  });
}

/**
 * 공개 배지 목록 (N-4 / N-9 / P-058).
 *
 * 두 겹으로 거른다: `public_badge_view` 가 SQL 로, `toPublicBadges()` 가 주어진 `now` 로.
 * 인증을 요구하지 않는다 — 공개 프로필 SSR 이 쓰는 경로이고, 뷰에 없는 컬럼은 나갈 길이 없다.
 */
export async function listBadges(profileId: string, now: Date = new Date()): Promise<PublicBadge[]> {
  const rows = await q<{
    id: string;
    badgeType: string;
    publicLabel: string;
    method: VerificationMethod;
    scope: string;
    issuerName: string | null;
    status: "active" | "expired" | "revoked" | "disputed";
    verifiedAt: Date | null;
    expiresAt: Date | null;
  }>(
    `SELECT id::text       AS "id",
            badge_type     AS "badgeType",
            public_label   AS "publicLabel",
            method,
            scope,
            issuer_name    AS "issuerName",
            status,
            verified_at    AS "verifiedAt",
            expires_at     AS "expiresAt"
       FROM public_badge_view
      WHERE profile_id = $1`,
    [profileId],
  );

  const issuerRequired = new Set(
    (await q<{ code: string }>(`SELECT code FROM evidence_types WHERE requires_issuer`)).map((r) => r.code),
  );

  const badges = toPublicBadges(rows as BadgeRow[], now, issuerRequired);
  // N-4 트립와이어. 운영 핫패스에서는 돌리지 않는다 (publicDto.ts 주석).
  if (process.env.NODE_ENV !== "production") assertNoPrivateKeys(badges);
  return badges;
}

/**
 * P-060: 만료 예정 배지. **워커 전용**이다 (`userId` 를 담고 있으므로 공개 경로에 연결하지 마라).
 * 상태를 바꾸지 않는다 — 만료 판정은 읽기 시점이 진실이다 (N-9).
 */
export async function expiringSoon(withinDays = 30, now: Date = new Date()): Promise<ExpiringBadge[]> {
  const rows = await q<{
    badgeId: string;
    profileId: string;
    userId: string;
    badgeType: string;
    publicLabel: string;
    expiresAt: Date;
  }>(
    `SELECT b.id::text      AS "badgeId",
            b.profile_id::text AS "profileId",
            p.user_id::text  AS "userId",
            b.badge_type     AS "badgeType",
            b.public_label   AS "publicLabel",
            b.expires_at     AS "expiresAt"
       FROM badges b
       JOIN profiles p ON p.id = b.profile_id
       JOIN users u ON u.id = p.user_id AND u.status = 'active' AND u.deleted_at IS NULL
      WHERE b.status = 'active'
        AND b.revoked_at IS NULL
        AND b.expires_at IS NOT NULL
        AND b.expires_at > now()
        AND b.expires_at <= now() + make_interval(days => $1::int)
      ORDER BY b.expires_at
      LIMIT 500`,
    [withinDays],
  );

  // SQL 과 같은 조건을 도메인 함수로 한 번 더 본다: 판정 기준이 두 곳에 있으면 테스트로 고정할 수 있어야 한다.
  return rows
    .filter((r) => isExpiringSoon(r.expiresAt, now, withinDays))
    .map((r) => ({
      badgeId: r.badgeId,
      profileId: r.profileId,
      userId: r.userId,
      badgeType: r.badgeType,
      publicLabel: r.publicLabel,
      expiresAt: iso(r.expiresAt) ?? "",
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// P-063 이의제기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-063: 이의제기 (보안정책 §4.6 "당사자는 정정 및 이의제기를 제출할 수 있다").
 *
 * 제출과 동시에 상태를 `disputed` 로 돌린다 — N-14 때문이다. 분쟁이 접수된 배지가
 * 심사 기간 내내 "현재 소속 확인"으로 보이면 확정적 표현을 쓰지 않겠다는 약속이 깨진다.
 * 라벨 치환은 domain(`toPublicBadge`)이 하고, 여기서는 상태만 바꾼다.
 */
export async function submitAppeal(ctx: Ctx, verificationId: string, reason: string): Promise<{ appealId: string; evidenceStatus: ProofStatus }> {
  if (!ctx.userId) throw unauthorized();
  const text = sanitizeText(reason, 2000);
  if (text.length < 5) throw badRequest("reason_required", "이의제기 사유를 입력해야 합니다.");
  const p = await principalOf(ctx);

  return tx(async (c) => {
    const v = await one<{ id: string; evidenceId: string; method: VerificationMethod; status: ProofStatus }>(
      `SELECT id::text AS "id", evidence_id::text AS "evidenceId", method, status
         FROM verifications WHERE id = $1`,
      [verificationId],
      c,
    );
    if (!v) throw notFound("verification");

    await c.query(`SELECT status FROM evidence WHERE id = $1 FOR UPDATE`, [v.evidenceId]);
    const ev = await loadEvidence(c, v.evidenceId);

    // 이의제기는 **당사자만** 한다. 검증자가 자기 판정에 이의를 제기하는 경로는 두지 않는다.
    const actor = resolveActor(ctx, p, ev);
    if (actor !== "owner") throw notFound("verification");

    const existing = await one<{ id: string }>(
      `SELECT id::text AS "id" FROM appeals WHERE verification_id = $1 AND status = 'open'`,
      [v.id],
      c,
    );
    if (existing) throw conflict("appeal_already_open", "이미 처리 중인 이의제기가 있습니다.");

    const row = await one<{ id: string }>(
      `INSERT INTO appeals (verification_id, submitted_by, reason) VALUES ($1,$2,$3) RETURNING id::text AS "id"`,
      [v.id, ctx.userId, text],
      c,
    );
    if (!row) throw unavailable("appeal_insert_failed");

    // 전이 가능한 상태(verified·rejected)에서만 disputed 로 간다. 그 밖이면 이의제기만 접수된다 —
    // 이미 검토 중인 증거를 disputed 로 밀어 큐에서 사라지게 하지 않으려는 것이다.
    let evidenceStatus = ev.status;
    if (ev.status === "verified" || ev.status === "rejected") {
      const outcome = await applyTransition(c, {
        ctx,
        ev,
        actor: "owner",
        actorUserId: ctx.userId,
        to: "disputed",
        opts: { method: v.method },
      });
      evidenceStatus = outcome.to;
    }

    await writeAudit(c, {
      eventType: "appeal.submitted",
      actorId: ctx.userId,
      actorRole: "owner",
      tenantId: ev.organizationId,
      aggregateType: "appeal",
      aggregateId: row.id,
      // 사유 본문은 감사로그에 넣지 않는다. 내용은 appeals 에 있고 감사로그는 "접수됐다"만 증명한다 (N-13).
      payload: { verificationId: v.id, evidenceId: ev.id },
      correlationId: ctx.requestId,
    });
    await enqueue(c, {
      eventType: "appeal.submitted",
      aggregateType: "appeal",
      aggregateId: row.id,
      tenantId: ev.organizationId,
      actorId: ctx.userId,
      correlationId: ctx.requestId,
      payload: { verificationId: v.id, evidenceId: ev.id },
    });

    return { appealId: row.id, evidenceStatus };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-066 / P-067 측정 지표 (N-8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-066: 측정 지표 등록. 기간·분모·표본수·산정근거가 없으면 **저장되지 않는다** (보안정책 §4.8).
 *
 * 세 겹이다: `validateMetricClaim()`(빈 근거·표본 0 까지) → DB NOT NULL → `public_metric_view` 필터.
 * P-067: `verificationId` 를 붙이려면 그 검증이 `system_integrated` + `verified` 여야 하고,
 * 아니면 DB 트리거가 거부한다. 트리거 메시지를 `metric_requires_integration` 으로 바꿔 돌려준다.
 */
export async function addMetricClaim(
  ctx: Ctx,
  input: MetricClaimInput & { verificationId?: string | null },
): Promise<MetricClaimDto> {
  if (!ctx.userId) throw unauthorized();
  const verdict = validateMetricClaim(input);
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  // N-12: 지표는 **내 프로필**에만 붙는다. profileId 를 입력으로 받지 않으므로 바꿔치기할 대상이 없다.
  const mine = await one<{ id: string }>(`SELECT id::text AS "id" FROM profiles WHERE user_id = $1`, [ctx.userId]);
  if (!mine) throw badRequest("profile_required", "먼저 프로필을 만들어야 합니다.");

  let verificationId: string | null = null;
  if (nonEmpty(input.verificationId)) {
    // 남의 검증 id 를 붙여 "검증된 수치"로 만드는 경로를 막는다 — 소유자 조건이 WHERE 에 있다.
    const v = await one<{ id: string; method: VerificationMethod; status: ProofStatus }>(
      `SELECT v.id::text AS "id", v.method, v.status
         FROM verifications v
         JOIN evidence e ON e.id = v.evidence_id
        WHERE v.id = $1 AND e.subject_type = 'profile' AND e.subject_id = $2`,
      [input.verificationId, mine.id],
    );
    if (!v) throw badRequest("verification_not_found", "근거 검증을 찾을 수 없습니다.");
    // P-067 을 트리거 전에 같은 말로 거절한다(더 나은 메시지를 주기 위해). 최종 판정은 트리거다.
    if (!isVerifiableMetric(v.method) || v.status !== "verified") {
      throw badRequest("metric_requires_integration", "검증된 거래 수치는 시스템 연동 증거만 근거로 쓸 수 있습니다.");
    }
    verificationId = v.id;
  }

  const basis = sanitizeText(input.basis, 500);
  const row = await tx(async (c) => {
    try {
      return await one<MetricRow>(
        `INSERT INTO metric_claims
           (profile_id, metric_code, value_numeric, unit, period_start, period_end, sample_size, basis, verification_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id::text AS "id", metric_code AS "metricCode", value_numeric::float8 AS "value", unit,
                   to_char(period_start,'YYYY-MM-DD') AS "periodStart", to_char(period_end,'YYYY-MM-DD') AS "periodEnd",
                   sample_size AS "sampleSize", basis, (verification_id IS NOT NULL) AS "verified"`,
        [
          mine.id,
          sanitizeText(input.metricCode, 60),
          input.value,
          sanitizeText(input.unit, 20),
          input.periodStart,
          input.periodEnd,
          input.sampleSize,
          basis,
          verificationId,
        ],
        c,
      );
    } catch (e) {
      throw mapTriggerError(e);
    }
  });
  if (!row) throw unavailable("metric_insert_failed");
  return toMetricDto(row);
}

interface MetricRow {
  id: string;
  metricCode: string;
  value: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  basis: string;
  verified: boolean;
}

function toMetricDto(r: MetricRow): MetricClaimDto {
  return {
    ...r,
    // N-8: 수치만 떼서 쓸 수 없게 공시 문구를 **같이** 돌려준다.
    disclosure: formatMetricDisclosure({
      metricCode: r.metricCode,
      value: r.value,
      unit: r.unit,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      sampleSize: r.sampleSize,
      basis: r.basis,
    }),
  };
}

/** 내 지표 목록. 소유자 조건은 `profiles.user_id` 조인에 있다. */
export async function listMetricClaims(ctx: Ctx): Promise<MetricClaimDto[]> {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<MetricRow>(
    `SELECT m.id::text AS "id", m.metric_code AS "metricCode", m.value_numeric::float8 AS "value", m.unit,
            to_char(m.period_start,'YYYY-MM-DD') AS "periodStart", to_char(m.period_end,'YYYY-MM-DD') AS "periodEnd",
            m.sample_size AS "sampleSize", m.basis, (m.verification_id IS NOT NULL) AS "verified"
       FROM metric_claims m
       JOIN profiles p ON p.id = m.profile_id
      WHERE p.user_id = $1
      ORDER BY m.period_end DESC, m.created_at DESC`,
    [ctx.userId],
  );
  return rows.map(toMetricDto);
}
