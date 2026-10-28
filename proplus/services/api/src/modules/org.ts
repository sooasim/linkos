/**
 * M05 Organization & Affiliation — P-080~P-086.
 *
 * 출처: 02_모듈명세_제품요구사항.md M05
 *   목적: 회사/대리점의 소속 검증 및 팀 관리.
 *   수용 기준: **조직 관리자만 해당 조직의 멤버십을 승인/취소할 수 있으며 개인 프로필 전체를 소유하지 않는다.**
 *
 * 이 모듈의 전부는 그 수용기준 한 줄(= 전략 §2 N-12)이다. 그래서 코드에서 두 가지를 구조적으로 못 박는다:
 *
 *   1. **이 모듈은 `profiles` 를 UPDATE 하지 않는다.** INSERT 도 하지 않는다.
 *      조직이 직원의 개인 프로필을 고칠 수 있으면 "개인이 소유하는 신뢰 자산"이라는 전제가 깨진다.
 *      퇴사(소속 취소)가 건드리는 것은 **affiliation 배지의 유효성**뿐이고, 개인 프로필·개인 증거·
 *      다른 유형의 배지(자격·경력)는 그대로 남는다 (P-084 수용기준).
 *   2. **권한은 이 모듈이 계산하지 않는다.** `users.platform_role` + `memberships` 로 Principal 을 조립해
 *      `@proplus/domain` 의 `assertCan()` 에 묻는다 (전략 §3 계층 규칙). 조직 관리자가 가질 수 있는 능력은
 *      `org.manage` / `org.member.verify` 까지이고, `profile.edit` 로 가는 길은 acl.ts 에 아예 없다.
 */

import {
  assertCan,
  generateToken,
  hashToken,
  maskEmail,
  normalizeSlug,
  sanitizeText,
  validateSlug,
  type Capability,
  type MemberRole,
  type PlatformRole,
  type Principal,
} from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { sendMail } from "../lib/mail";
import { enqueue } from "../lib/outbox";

/** 초대 링크 유효기간. 보안정책 §2 — 수락되지 않은 초대가 무기한 살아 있지 않게 한다. */
const INVITE_TTL_DAYS = 7;

/** 초대 가능한 역할. `owner` 는 초대로 만들지 않는다 — 소유권 이전은 별도 절차여야 추적된다. */
const INVITABLE_ROLES: readonly MemberRole[] = ["member", "manager"];

/** DNS TXT 에 넣을 값의 접두사. 다른 서비스의 검증 문자열이 우연히 통과하지 않게 이름공간을 박는다. */
const DOMAIN_TXT_PREFIX = "proplus-verify=";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// ─────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateOrganizationInput {
  name: string;
  /** 생략하면 이름에서 만든다. 공개 URL 조각이므로 도메인의 slug 규칙을 그대로 쓴다. */
  slug?: string | null;
  /** 사업자번호 **원문이 아니라** 외부 참조 키다 (데이터모델 §1 — 원문은 이 DB 에 들어오지 않는다). */
  legalIdentifierRef?: string | null;
}

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  /** 주장된 도메인. **검증 여부의 진실은 `domainVerifiedAt`** 이다 (아래 startDomainVerification 주석 참조). */
  domain: string | null;
  domainVerifiedAt: string | null;
  status: string;
  createdAt: string;
  myRole: MemberRole;
  /** 관리자에게만, 그리고 아직 검증되지 않았을 때만 채운다. DNS 에 공개할 값이므로 비밀이 아니다. */
  pendingTxtRecord?: DomainChallenge | null;
}

export interface DomainChallenge {
  domain: string;
  recordType: "TXT";
  /** TXT 를 붙일 호스트. 루트 도메인에 붙인다 — 서브도메인 규칙은 DNS 제공자마다 달라서 혼선이 크다. */
  recordHost: string;
  recordValue: string;
}

export interface MemberView {
  userId: string;
  role: MemberRole;
  status: string;
  /** P-085: `status='active'` 라도 `ended_at` 이 지났으면 효력이 없다. 읽기 시점에 판정한 값이다. */
  effectiveActive: boolean;
  startedAt: string | null;
  endedAt: string | null;
  verifiedAt: string | null;
  /** N-13: 원문 이메일을 응답에 담지 않는다. 멤버 식별에는 마스킹으로 충분하다. */
  emailMasked: string | null;
  profileSlug: string | null;
  displayName: string | null;
}

export interface InviteResult {
  id: string;
  /**
   * 평문 초대 토큰. DB 에는 해시만 남는다(`org_invites.token_hash`).
   * 호출부(메일 발송·"링크 복사" UI)가 쓰도록 **한 번만** 돌려주고 서버는 보관하지 않는다.
   */
  token: string;
  acceptUrl: string;
  role: MemberRole;
  emailMasked: string;
  expiresAt: string;
  /** SMTP 미설정(로컬·CI)이면 false. 발송 실패가 초대 생성을 롤백시키지는 않는다. */
  mailed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-080 조직 생성
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 수용기준(P-080): **생성자가 첫 관리자가 되고 감사로그에 남는다.**
 *
 * 생성자 멤버십의 `verified_by` 를 자기 자신으로 두는 이유: "누가 이 소속을 확정했나"를 항상 복원할 수 있어야
 * 하고, 조직의 첫 행은 그 답이 "스스로"다. NULL 로 비워 두면 나중에 승인 경로와 구분되지 않는다.
 */
export async function createOrganization(ctx: Ctx, input: CreateOrganizationInput): Promise<OrganizationView> {
  const userId = requireUser(ctx);

  const name = sanitizeText(input.name ?? "", 120);
  if (name.length < 2) throw badRequest("org_name_required", "조직 이름을 2자 이상 입력하세요.");

  const rawSlug = input.slug?.trim() ? input.slug.trim() : normalizeSlug(name);
  const verdict = validateSlug(rawSlug);
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  const legalRef = input.legalIdentifierRef ? sanitizeText(input.legalIdentifierRef, 120) : null;

  return tx(async (c) => {
    let org: OrgRow | null;
    try {
      org = await one<OrgRow>(
        `INSERT INTO organizations (name, slug, legal_identifier_ref)
         VALUES ($1,$2,$3)
         RETURNING id, name, slug, verified_domain, domain_verified_at, domain_challenge, status, created_at`,
        [name, verdict.slug, legalRef],
        c,
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("org_slug_taken", "이미 사용 중인 조직 주소입니다.");
      throw e;
    }
    if (!org) throw conflict("org_create_failed", "조직을 생성할 수 없습니다.");

    await c.query(
      `INSERT INTO memberships (organization_id, user_id, role, status, started_at, verified_by, verified_at)
       VALUES ($1,$2,'owner','active', now(), $2, now())`,
      [org.id, userId],
    );

    await writeAudit(c, {
      eventType: "organization.created",
      actorId: userId,
      actorRole: "owner",
      tenantId: org.id,
      aggregateType: "organization",
      aggregateId: org.id,
      payload: { slug: org.slug },
      correlationId: ctx.requestId,
    });

    return toOrganizationView(org, "owner", true);
  });
}

/**
 * P-086 과 같은 테넌트 규칙: **멤버만** 자기 조직을 조회한다.
 *
 * 멤버가 아니면 403 이 아니라 404 를 돌려준다 — 403 은 "그 id 의 조직이 존재한다"를 알려 주므로
 * uuid 를 훑어 조직 존재 여부를 수집할 수 있다. (운영자 조회는 이 함수가 아니라 접근 사유를 남기는
 * 별도 감사 경로를 거친다 — P-165 / `modules/admin.ts`.)
 */
export async function getOrganization(ctx: Ctx, id: string): Promise<OrganizationView> {
  const userId = requireUser(ctx);
  const row = await one<OrgRow & { role: MemberRole; member_status: string; effective_active: boolean }>(
    `SELECT o.id, o.name, o.slug, o.verified_domain, o.domain_verified_at, o.domain_challenge, o.status, o.created_at,
            m.role, m.status AS member_status,
            (m.status = 'active' AND (m.ended_at IS NULL OR m.ended_at > now())) AS effective_active
       FROM organizations o
       JOIN memberships m ON m.organization_id = o.id AND m.user_id = $2
      WHERE o.id = $1 AND m.status <> 'revoked'`,
    [id, userId],
  );
  if (!row) throw notFound("organization");
  return toOrganizationView(row, row.role, row.effective_active);
}

/** 내 소속 목록. 취소된 소속은 숨긴다 — 워크스페이스 전환 메뉴에 쓰이는 값이다. */
export async function myOrganizations(ctx: Ctx): Promise<
  (Pick<OrganizationView, "id" | "name" | "slug" | "domain" | "domainVerifiedAt" | "myRole"> & {
    status: string;
    effectiveActive: boolean;
  })[]
> {
  const userId = requireUser(ctx);
  const rows = await q<{
    id: string;
    name: string;
    slug: string;
    verified_domain: string | null;
    domain_verified_at: Date | null;
    role: MemberRole;
    status: string;
    effective_active: boolean;
  }>(
    `SELECT o.id, o.name, o.slug, o.verified_domain, o.domain_verified_at, m.role, m.status,
            (m.status = 'active' AND (m.ended_at IS NULL OR m.ended_at > now())) AS effective_active
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status <> 'revoked'
      ORDER BY o.name`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    domain: r.verified_domain,
    domainVerifiedAt: iso(r.domain_verified_at),
    myRole: r.role,
    status: r.status,
    effectiveActive: r.effective_active,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// P-081 도메인 소유 검증 (DNS TXT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 도메인 소유 검증을 시작하고 사용자가 넣어야 할 TXT 레코드를 돌려준다.
 *
 * **왜 challenge 를 평문으로 저장하는가** (토큰은 해시로만 저장한다는 CLAUDE.md §5 의 예외):
 * 그 규칙은 "사용자가 **제시**하는 bearer 토큰"을 위한 것이다. 이 값은 반대로 사용자가 **공개 DNS 에 게시**하는
 * 값이고, 서버는 조회된 TXT 와 대조해야 한다 — 해시만 들고 있으면 대조는 되지만 "무엇을 넣어야 하는지"를
 * 다시 보여줄 수 없다(설정 화면을 새로 열면 끝난다). 또한 이 값 자체로는 아무 권한도 얻지 못한다
 * (DNS 에 넣을 수 있는 사람 = 도메인 소유자라는 사실이 증명의 전부다).
 *
 * **왜 `verified_domain` 에 미검증 도메인을 쓰는가:** 0001 마이그레이션의 `org_domain_verified_pair` CHECK 가
 * `domain_verified_at IS NULL OR verified_domain IS NOT NULL` 이다. 즉 스키마는 "도메인만 있고 검증시각 없음"을
 * 허용하고 그 반대를 금지한다 — **검증 여부의 진실은 `domain_verified_at`** 이라는 뜻이다. 재검증을 시작하면
 * `domain_verified_at` 을 NULL 로 되돌리므로, 검증이 끝날 때까지 소속 확정이 막힌다(아래 가드).
 */
export async function startDomainVerification(ctx: Ctx, orgId: string, domain: string): Promise<DomainChallenge> {
  const userId = requireUser(ctx);
  const principal = await loadPrincipal(userId);
  must(principal, "org.manage", { organizationId: orgId });

  const normalized = normalizeDomain(domain);
  if (!normalized) throw badRequest("invalid_domain", "도메인 형식이 올바르지 않습니다. 예: example.com");

  // 같은 도메인을 두 조직이 소속 근거로 쓰면 소속 증명이 의미를 잃는다 (P-081).
  const taken = await one<{ id: string }>(
    `SELECT id FROM organizations
      WHERE verified_domain = $1 AND domain_verified_at IS NOT NULL AND id <> $2`,
    [normalized, orgId],
  );
  if (taken) throw conflict("domain_taken", "이미 다른 조직이 검증한 도메인입니다.");

  const challenge = generateToken();

  return tx(async (c) => {
    const row = await one<{ id: string }>(
      `UPDATE organizations
          SET verified_domain = $2, domain_verified_at = NULL, domain_challenge = $3
        WHERE id = $1
        RETURNING id`,
      [orgId, normalized, challenge],
      c,
    );
    if (!row) throw notFound("organization");

    await writeAudit(c, {
      eventType: "organization.domain_challenge_issued",
      actorId: userId,
      actorRole: "org_manager",
      tenantId: orgId,
      aggregateType: "organization",
      aggregateId: orgId,
      // 도메인은 PII 가 아니다. challenge 는 남기지 않는다 — 감사로그가 그 값의 사본을 들고 있을 이유가 없다.
      payload: { domain: normalized },
      correlationId: ctx.requestId,
    });

    return txtRecordFor(normalized, challenge);
  });
}

/**
 * 조회된 TXT 값과 challenge 를 대조한다.
 *
 * **왜 DNS 를 직접 조회하지 않고 `lookupTxt` 를 인자로 받는가:**
 * 전략 §3 계층 규칙에서 모듈은 SQL·트랜잭션을 하지만, 네트워크 조회를 섞으면 이 함수는
 * "DNS 가 뜬 환경"에서만 테스트할 수 있게 된다. 도메인 검증에서 틀리면 안 되는 부분은 네트워크가 아니라
 * **대조 규칙**(접두사 요구·공백/따옴표 처리·상수시간 비교)이고, 그건 순수 입력으로 전수 테스트해야 한다.
 * 실제 조회(`node:dns` 의 `resolveTxt`)는 라우트/워커가 하고 결과 배열만 여기로 넘긴다.
 *
 * 실패를 예외가 아니라 `{ verified: false }` 로 돌려주는 이유: "아직 전파되지 않음"은 오류가 아니라
 * 흔한 정상 상태다. 사용자는 다시 누르면 된다.
 */
export async function confirmDomainVerification(
  ctx: Ctx,
  orgId: string,
  lookupTxt: readonly string[],
): Promise<{ verified: boolean; domain: string | null; alreadyVerified: boolean; expected?: DomainChallenge }> {
  const userId = requireUser(ctx);
  const principal = await loadPrincipal(userId);
  must(principal, "org.manage", { organizationId: orgId });

  const org = await one<OrgRow>(
    `SELECT id, name, slug, verified_domain, domain_verified_at, domain_challenge, status, created_at
       FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw notFound("organization");
  if (org.domain_verified_at) {
    return { verified: true, domain: org.verified_domain, alreadyVerified: true };
  }
  if (!org.verified_domain || !org.domain_challenge) {
    throw conflict("domain_verification_not_started", "도메인 검증을 먼저 시작하세요.");
  }

  const expected = `${DOMAIN_TXT_PREFIX}${org.domain_challenge}`;
  const matched = (lookupTxt ?? []).some((raw) => normalizeTxtValue(raw) === expected);
  if (!matched) {
    return {
      verified: false,
      domain: org.verified_domain,
      alreadyVerified: false,
      expected: txtRecordFor(org.verified_domain, org.domain_challenge),
    };
  }

  const domain = org.verified_domain;
  await tx(async (c) => {
    // challenge 는 역할을 다했으면 지운다. 남겨 두면 다음 검증에서 재사용되고, 그건 한 번 노출된 값이
    // 계속 유효하다는 뜻이 된다.
    await c.query(
      `UPDATE organizations SET domain_verified_at = now(), domain_challenge = NULL WHERE id = $1`,
      [orgId],
    );
    await writeAudit(c, {
      eventType: "organization.domain_verified",
      actorId: userId,
      actorRole: "org_manager",
      tenantId: orgId,
      aggregateType: "organization",
      aggregateId: orgId,
      payload: { domain },
      correlationId: ctx.requestId,
    });
  });

  return { verified: true, domain, alreadyVerified: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-082 직원 초대 / 수락
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 초대 토큰은 **해시만** 저장하고(`org_invites.token_hash`) TTL·1회성이다 (P-082 수용기준).
 *
 * 같은 이메일의 미사용 초대를 먼저 만료시키는 이유: 유효한 링크가 여러 개면 회수가 불가능해진다.
 * `org_invites` 에는 revoke 컬럼이 없으므로 `expires_at = now()` 가 그 역할을 한다.
 */
export async function invite(ctx: Ctx, orgId: string, email: string, role: MemberRole = "member"): Promise<InviteResult> {
  const userId = requireUser(ctx);
  const principal = await loadPrincipal(userId);
  must(principal, "org.manage", { organizationId: orgId });

  if (!INVITABLE_ROLES.includes(role)) {
    throw badRequest("invalid_role", "초대할 수 있는 역할은 멤버 또는 관리자입니다.");
  }
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 200) {
    throw badRequest("invalid_email", "이메일 형식이 올바르지 않습니다.");
  }

  const org = await requireActiveOrg(orgId);

  const existing = await one<{ user_id: string }>(
    `SELECT m.user_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND lower(u.email) = $2 AND m.status = 'active'
        AND (m.ended_at IS NULL OR m.ended_at > now())`,
    [orgId, normalizedEmail],
  );
  if (existing) throw conflict("already_member", "이미 소속된 멤버입니다.");

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

  const inviteId = await tx(async (c) => {
    await c.query(
      `UPDATE org_invites SET expires_at = now()
        WHERE organization_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND expires_at > now()`,
      [orgId, normalizedEmail],
    );
    const row = await one<{ id: string }>(
      `INSERT INTO org_invites (organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [orgId, normalizedEmail, role, hashToken(token), userId, expiresAt],
      c,
    );
    if (!row) throw conflict("invite_create_failed", "초대를 생성할 수 없습니다.");

    await writeAudit(c, {
      eventType: "organization.invited",
      actorId: userId,
      actorRole: "org_manager",
      tenantId: orgId,
      aggregateType: "org_invite",
      aggregateId: row.id,
      // N-13: 초대 이메일 원문은 남기지 않는다 (redact 가 'email' 키를 가리지만 애초에 담지 않는다).
      payload: { role, emailMasked: maskEmail(normalizedEmail) },
      correlationId: ctx.requestId,
    });
    return row.id;
  });

  const acceptUrl = `${appOrigin()}/app/orgs/invite/${token}`;
  // 트랜잭션 **밖에서** 보낸다: 메일 실패가 초대 레코드를 롤백시키면 사용자는 링크 복사도 못 한다.
  const mailed = await sendMail(
    normalizedEmail,
    `${org.name} 소속 확인 초대`,
    `${org.name} 의 소속 확인 초대입니다. 아래 링크에서 수락하세요 (${INVITE_TTL_DAYS}일 내 유효).\n\n${acceptUrl}\n`,
  );

  return {
    id: inviteId,
    token,
    acceptUrl,
    role,
    emailMasked: maskEmail(normalizedEmail),
    expiresAt: expiresAt.toISOString(),
    mailed,
  };
}

/**
 * 초대 수락. 수락 시점에 소속이 **활성**이 된다 — 초대 자체가 조직 관리자의 승인 행위이므로
 * 승인을 한 번 더 받지 않는다 (P-083 의 "관리자만 승인한다"는 `invited_by` 로 기록된다).
 *
 * 계정 이메일과 초대 이메일을 대조하는 이유: 초대 토큰은 bearer 라서 링크가 전달·유출되면 누구나
 * 소속을 주장할 수 있다. 소속은 공개 배지의 근거이므로 "링크를 가진 사람"보다 좁은 조건이 필요하다
 * (보안정책 §2).
 */
export async function acceptInvite(ctx: Ctx, token: string): Promise<{ organizationId: string; role: MemberRole; organizationName: string }> {
  const userId = requireUser(ctx);
  if (typeof token !== "string" || token.length < 20 || token.length > 200) throw notFound("invite");

  return tx(async (c) => {
    const inv = await one<{
      id: string;
      organization_id: string;
      email: string;
      role: MemberRole;
      invited_by: string;
      expires_at: Date;
      accepted_at: Date | null;
      org_name: string;
      org_status: string;
      domain_claimed: boolean;
      domain_verified: boolean;
    }>(
      `SELECT i.id, i.organization_id, i.email, i.role, i.invited_by, i.expires_at, i.accepted_at,
              o.name AS org_name, o.status AS org_status,
              (o.verified_domain IS NOT NULL) AS domain_claimed,
              (o.domain_verified_at IS NOT NULL) AS domain_verified
         FROM org_invites i
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1
        FOR UPDATE OF i`,
      [hashToken(token)],
      c,
    );
    if (!inv) throw notFound("invite");
    if (inv.accepted_at) throw conflict("invite_used", "이미 사용된 초대입니다.");
    if (inv.expires_at.getTime() <= Date.now()) throw conflict("invite_expired", "만료된 초대입니다.");
    if (inv.org_status !== "active") throw conflict("org_suspended", "조직이 비활성 상태입니다.");
    assertAffiliationAuthority(inv.domain_claimed, inv.domain_verified);

    const me = await one<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId], c);
    if (!me?.email || me.email.trim().toLowerCase() !== inv.email.trim().toLowerCase()) {
      throw forbidden("초대 받은 이메일의 계정으로 로그인한 뒤 수락하세요.");
    }

    // 재입사(이전 소속이 revoked)도 같은 경로로 처리한다 — ended_at 을 비워 소속을 되살린다.
    // 이전 affiliation 배지는 되살리지 않는다: 배지는 M04 가 새 검증을 근거로 다시 발급한다 (N-1).
    await c.query(
      `INSERT INTO memberships (organization_id, user_id, role, status, started_at, verified_by, verified_at)
       VALUES ($1,$2,$3,'active', now(), $4, now())
       ON CONFLICT (organization_id, user_id) DO UPDATE
         SET role = EXCLUDED.role,
             status = 'active',
             started_at = COALESCE(memberships.started_at, now()),
             ended_at = NULL,
             verified_by = EXCLUDED.verified_by,
             verified_at = now()`,
      [inv.organization_id, userId, inv.role, inv.invited_by],
    );
    await c.query(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [inv.id]);

    await writeAudit(c, {
      eventType: "organization.member_joined",
      actorId: userId,
      tenantId: inv.organization_id,
      aggregateType: "membership",
      aggregateId: null,
      payload: { organizationId: inv.organization_id, userId, role: inv.role, via: "invite" },
      correlationId: ctx.requestId,
    });

    return { organizationId: inv.organization_id, role: inv.role, organizationName: inv.org_name };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P-083 소속 승인 / P-084 소속 취소
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-083: **조직 관리자만 승인한다. 승인은 소속 사실만 확정하고 프로필 소유권을 주지 않는다 (N-12).**
 *
 * 이 함수가 쓰는 테이블은 `memberships` 뿐이다. `profiles` 는 읽지도 쓰지도 않는다.
 *
 * **왜 여기서 affiliation 배지를 만들지 않는가:** 배지는 `evidence → verifications(verified) → badges` 사슬을
 * 지나야만 존재할 수 있고(0001 의 `badges_require_verified_trg`), 그 사슬을 조직이 직접 만들면
 * 조직이 자기 직원의 검증자가 된다 — 보안정책 §4.4 가 금지하는 구조다. 여기서는 "조직이 소속을 확인했다"는
 * 사실만 남기고, 그 사실을 근거로 `issuer_confirmed` 검증과 배지를 만드는 일은 M04(`modules/proof.ts`)가 한다.
 */
export async function verifyMembership(ctx: Ctx, orgId: string, userId: string): Promise<MemberView> {
  const actorId = requireUser(ctx);
  const principal = await loadPrincipal(actorId);
  must(principal, "org.member.verify", { organizationId: orgId });

  const org = await requireActiveOrg(orgId);
  assertAffiliationAuthority(org.verified_domain !== null, org.domain_verified_at !== null);

  const row = await tx(async (c) => {
    const updated = await one<MemberRow>(
      `UPDATE memberships
          SET status = 'active',
              started_at = COALESCE(started_at, now()),
              ended_at = NULL,
              verified_by = $3,
              verified_at = now()
        WHERE organization_id = $1 AND user_id = $2
        RETURNING user_id, role, status, started_at, ended_at, verified_at,
                  (status = 'active' AND (ended_at IS NULL OR ended_at > now())) AS effective_active,
                  NULL::text AS email, NULL::text AS profile_slug, NULL::text AS display_name`,
      [orgId, userId, actorId],
      c,
    );
    if (!updated) throw notFound("membership");

    await writeAudit(c, {
      eventType: "organization.membership_verified",
      actorId,
      actorRole: "org_manager",
      tenantId: orgId,
      aggregateType: "membership",
      aggregateId: null,
      payload: { organizationId: orgId, userId, role: updated.role },
      correlationId: ctx.requestId,
    });
    return updated;
  });

  return toMemberView(row);
}

/**
 * P-084: **소속 배지는 즉시 만료되고 개인 프로필과 개인 증거는 남는다.**
 *
 * 한 트랜잭션에 묶는 이유: 멤버십만 끊고 배지가 남는 창이 생기면 그 창 동안 퇴사자가 공개 프로필에서
 * "현재 소속 확인"을 들고 있다. 반대로 배지만 만료되고 멤버십이 남으면 권한이 살아 있다. 둘 다 사고다.
 *
 * `badges` 는 M04 의 테이블이지만 여기서 **상태만** 바꾼다 — 발급(INSERT)은 하지 않는다.
 * 만료 대상은 `verification → evidence.organization_id` 로 **이 조직에서 나온 affiliation 배지**로 한정한다.
 * 다른 조직의 소속 배지나 자격·경력 배지는 건드리지 않는다.
 *
 * N-9 와의 관계: 공개 뷰(`public_badge_view`)는 `expires_at > now()` 를 읽기 시점에 판정하므로
 * `status='expired'` 와 `expires_at=now()` 를 함께 써서 두 읽기 경로의 결론이 같게 만든다.
 */
export async function revokeMembership(
  ctx: Ctx,
  orgId: string,
  userId: string,
  reason: string,
): Promise<{ userId: string; badgesExpired: number }> {
  const actorId = requireUser(ctx);
  const principal = await loadPrincipal(actorId);
  must(principal, "org.member.verify", { organizationId: orgId });

  const reasonText = sanitizeText(reason ?? "", 300);
  if (reasonText.length === 0) throw badRequest("reason_required", "소속 취소 사유를 입력하세요.");

  // 마지막 관리자를 잃으면 이 조직의 멤버십을 아무도 관리할 수 없다(복구가 운영 수작업이 된다).
  const owners = await q<{ user_id: string }>(
    `SELECT user_id FROM memberships
      WHERE organization_id = $1 AND status = 'active' AND role = 'owner'
        AND (ended_at IS NULL OR ended_at > now())`,
    [orgId],
  );
  if (owners.length === 1 && owners[0]?.user_id === userId) {
    throw conflict("last_owner", "마지막 소유자의 소속은 취소할 수 없습니다. 먼저 다른 소유자를 지정하세요.");
  }

  return tx(async (c) => {
    const membership = await one<{ id: string; role: MemberRole }>(
      `UPDATE memberships
          SET status = 'revoked', ended_at = now()
        WHERE organization_id = $1 AND user_id = $2 AND status <> 'revoked'
        RETURNING id, role`,
      [orgId, userId],
      c,
    );
    if (!membership) throw notFound("membership");

    const expired = await q<{ id: string }>(
      `UPDATE badges b
          SET status = 'expired', expires_at = now()
        WHERE b.badge_type = 'affiliation'
          AND b.status = 'active'
          AND b.profile_id IN (SELECT id FROM profiles WHERE user_id = $1)
          AND EXISTS (
            SELECT 1
              FROM verifications v
              JOIN evidence e ON e.id = v.evidence_id
             WHERE v.id = b.verification_id AND e.organization_id = $2
          )
        RETURNING b.id`,
      [userId, orgId],
      c,
    );

    // 외부 연동(CRM·팀 페이지·검색 색인)이 소속을 들고 있으므로 같은 트랜잭션에서 알린다 (P-183).
    await enqueue(c, {
      eventType: "membership.revoked",
      aggregateType: "membership",
      aggregateId: membership.id,
      tenantId: orgId,
      actorId,
      correlationId: ctx.requestId,
      payload: { organizationId: orgId, userId, role: membership.role, badgesExpired: expired.length },
    });

    await writeAudit(c, {
      eventType: "organization.membership_revoked",
      actorId,
      actorRole: "org_manager",
      tenantId: orgId,
      aggregateType: "membership",
      aggregateId: membership.id,
      payload: { organizationId: orgId, userId, reason: reasonText, badgesExpired: expired.length },
      correlationId: ctx.requestId,
    });

    return { userId, badgesExpired: expired.length };
  });
}

/**
 * P-086: **같은 조직 관리자만 조회. 테넌트 침범 차단.**
 *
 * 응답에 프로필 본문·연락처가 없는 이유는 N-12 다. 조직이 알아야 하는 것은 "누가 소속인가"이고,
 * 그 사람의 개인 프로필은 조직의 자산이 아니다. 식별에 필요한 최소값(이름·공개 슬러그)과
 * 마스킹 이메일만 돌려준다.
 */
export async function listMembers(ctx: Ctx, orgId: string): Promise<MemberView[]> {
  const actorId = requireUser(ctx);
  const principal = await loadPrincipal(actorId);
  must(principal, "org.manage", { organizationId: orgId });

  const rows = await q<MemberRow>(
    `SELECT m.user_id, m.role, m.status, m.started_at, m.ended_at, m.verified_at,
            (m.status = 'active' AND (m.ended_at IS NULL OR m.ended_at > now())) AS effective_active,
            u.email, p.slug AS profile_slug, p.display_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.organization_id = $1
      ORDER BY m.created_at`,
    [orgId],
  );
  return rows.map(toMemberView);
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부
// ─────────────────────────────────────────────────────────────────────────────

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  verified_domain: string | null;
  domain_verified_at: Date | null;
  domain_challenge: string | null;
  status: string;
  created_at: Date;
};

type MemberRow = {
  user_id: string;
  role: MemberRole;
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  verified_at: Date | null;
  effective_active: boolean;
  email: string | null;
  profile_slug: string | null;
  display_name: string | null;
};

/**
 * P-081 가드: **도메인을 주장만 하고 검증을 끝내지 않은 조직은 소속을 확정할 수 없다.**
 *
 * 왜 배지 발급 함수가 아니라 소속 확정 지점에 두는가: affiliation 배지의 유일한 근거는 활성 멤버십이다.
 * 배지 쪽에만 가드를 두면 그 전에 이미 "조직이 확인한 소속"이 DB 에 남고, 팀 페이지·검색·외부 연동이
 * 그걸 믿는다. 그래서 소속이 활성이 되는 두 경로(`acceptInvite` · `verifyMembership`)를 막는다.
 *
 * 왜 "도메인이 아예 없는 조직"은 통과시키는가: 도메인을 쓰지 않는 조직의 소속은 M04 의 서류 확인
 * (`document_reviewed`) 경로로 간다. 도메인 없음까지 차단하면 그 경로가 죽는다. 막아야 하는 것은
 * **미완료 도메인 주장**을 근거로 소속을 확정하는 일이다.
 *
 * TODO(P-081): M04 의 affiliation 배지 발급 경로도 `organizations.domain_verified_at` 을 함께 확인해야 한다
 * (같은 규칙을 두 계층에서 지키는 것은 N-1 을 CHECK 와 전이함수로 이중으로 막는 것과 같은 이유다).
 */
function assertAffiliationAuthority(domainClaimed: boolean, domainVerified: boolean): void {
  if (domainClaimed && !domainVerified) {
    throw conflict(
      "org_domain_unverified",
      "조직 도메인 검증이 완료되지 않았습니다. DNS TXT 검증을 마친 뒤 소속을 확정하세요.",
    );
  }
}

/**
 * 권한 판단에 필요한 Principal 을 DB 에서 조립한다 (전략 §3: 모듈이 조립하고 판정은 domain 이 한다).
 *
 * P-085 를 **읽기 시점에** 적용한다: `status='active'` 인데 `ended_at` 이 지난 행은 `'revoked'` 로 바꿔
 * 넘긴다. 만료 배치가 늦게 돌아도 권한이 살아 있지 않아야 하고, `acl.isOrgManager()` 는 `'active'` 만
 * 관리자로 인정하기 때문이다.
 *
 * (`modules/lead.ts` 에 같은 함수가 있다. 공용 헬퍼를 둘 자리가 계약(`docs/CONTRACTS.md`)에 없고
 *  모듈끼리 import 하면 계층이 흐려지므로 지금은 중복을 택한다 — 쓰는 모듈이 셋 이상 되면
 *  `lib/principal.ts` 로 올린다.)
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

/** `assertCan` 은 `Error('forbidden:<cap>')` 를 던진다. HTTP 의미(403)를 모듈 경계에서 붙인다 (P-187). */
function must(principal: Principal, cap: Capability, target: { ownerUserId?: string; organizationId?: string }): void {
  try {
    assertCan(principal, cap, target);
  } catch {
    throw forbidden("이 조직에 대한 권한이 없습니다.");
  }
}

async function requireActiveOrg(orgId: string): Promise<OrgRow> {
  const org = await one<OrgRow>(
    `SELECT id, name, slug, verified_domain, domain_verified_at, domain_challenge, status, created_at
       FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw notFound("organization");
  if (org.status !== "active") throw conflict("org_suspended", "조직이 비활성 상태입니다.");
  return org;
}

function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw unauthorized();
  return ctx.userId;
}

function toOrganizationView(row: OrgRow, myRole: MemberRole, canSeeChallenge: boolean): OrganizationView {
  const view: OrganizationView = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    domain: row.verified_domain,
    domainVerifiedAt: iso(row.domain_verified_at),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    myRole,
  };
  const isManager = myRole === "manager" || myRole === "owner";
  if (canSeeChallenge && isManager && !row.domain_verified_at && row.verified_domain && row.domain_challenge) {
    view.pendingTxtRecord = txtRecordFor(row.verified_domain, row.domain_challenge);
  }
  return view;
}

function toMemberView(row: MemberRow): MemberView {
  return {
    userId: row.user_id,
    role: row.role,
    status: row.status,
    effectiveActive: row.effective_active,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    verifiedAt: iso(row.verified_at),
    emailMasked: row.email ? maskEmail(row.email) : null,
    profileSlug: row.profile_slug,
    displayName: row.display_name,
  };
}

function txtRecordFor(domain: string, challenge: string): DomainChallenge {
  return { domain, recordType: "TXT", recordHost: domain, recordValue: `${DOMAIN_TXT_PREFIX}${challenge}` };
}

/**
 * DNS 응답 정규화. 제공자·resolver 에 따라 값이 따옴표로 감싸이거나 공백이 붙어 온다.
 * 긴 TXT 는 255바이트 조각으로 쪼개져 배열로 오므로 호출부가 조각을 이어 붙여 넘긴다
 * (`node:dns` 의 `resolveTxt` 는 `string[][]` 를 준다 — 안쪽 배열을 `join("")` 한 결과가 한 레코드다).
 */
function normalizeTxtValue(raw: string): string {
  return String(raw ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
}

/**
 * 도메인 정규화. 교정이 아니라 **거부** 쪽으로 기운다 — `https://evil.com/a@good.com` 류 입력을
 * 관대하게 해석하면 "어느 도메인을 검증했는가"가 파서에 따라 달라진다.
 */
function normalizeDomain(raw: string): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  const labels = s.split(".");
  if (labels.some((l) => l.length > 63)) return null;
  const tld = labels[labels.length - 1] ?? "";
  // punycode TLD(`xn--`)를 제외하면 TLD 는 알파벳이다. 숫자 TLD 는 IP 오입력이다.
  if (!/^[a-z]{2,}$/.test(tld) && !tld.startsWith("xn--")) return null;
  return s;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "23505";
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** 메일·초대 링크에 박히는 절대 주소 (.env.example APP_ORIGIN). 운영은 https://proplus.linkos.com */
function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "http://localhost:4400";
}
