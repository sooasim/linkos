/**
 * 권한 판정 — N-12 (모듈명세 M05) + 기술백서 §5 최소권한.
 *
 * P-009 역할 기반 권한 · P-083 소속 승인 · P-103 리드 inbox(IDOR 차단) · P-165 운영자 접근 사유
 *
 * 설계 의도 세 가지:
 *
 * 1. **조직은 개인 프로필을 소유하지 않는다 (N-12).**
 *    `profile.edit` 로 가는 길은 "본인"뿐이다. 조직 관리자 경로도, 플랫폼 관리자 경로도 없다 —
 *    있으면 회사가 직원의 개인 신뢰 자산을 고쳐 쓸 수 있고, 그건 PROPLUS 의 전제를 깬다.
 *    조직이 할 수 있는 일은 `org.manage` / `org.member.verify`(소속 승인)까지다.
 *
 * 2. **검증 권한은 플랫폼 역할에서만 나온다.**
 *    `evidence.review` / `badge.issue` / `badge.revoke` / `audit.read` 는 조직 역할로 얻을 수 없다.
 *    조직 관리자가 자기 직원의 증거를 스스로 "검증"하면 검증의 의미가 없어진다 (보안정책 §4.4).
 *
 * 3. **고객 PII 는 플랫폼 역할로 열리지 않는다.**
 *    `lead.read` 는 프로필 소유자와 해당 조직 관리자만이다. 운영자의 고객 데이터 조회는
 *    이 능력이 아니라 **접근 사유를 남기는 별도 감사 경로**(P-165, `modules/admin.ts`)를 거친다.
 *    여기서 admin 에게 통과를 주면 그 감사 경로를 우회하는 지름길이 생긴다.
 */

import { type MemberRole, type PlatformRole } from "./types";

export type Capability =
  | "profile.edit"
  | "evidence.submit"
  | "evidence.review"
  | "badge.issue"
  | "badge.revoke"
  | "org.manage"
  | "org.member.verify"
  | "lead.read"
  | "lead.assign"
  | "audit.read"
  | "report.handle"
  | "admin.access";

export interface Principal {
  /** null 이면 비로그인. 공개 프로필 조회는 능력이 아니라 공개 뷰로 처리하므로 여기서는 전부 거부다. */
  userId: string | null;
  platformRole: PlatformRole;
  /** `memberships` 행. status 는 'pending' | 'active' | 'revoked' (DB CHECK). */
  memberships: readonly { organizationId: string; role: MemberRole; status: string }[];
}

export interface CapabilityTarget {
  /** 대상 리소스의 소유자(개인). 프로필·증거·리드가 붙어 있는 사람. */
  ownerUserId?: string;
  /** 대상 리소스가 속한 조직. */
  organizationId?: string;
  /**
   * 이 리소스에 **배정된 담당자** (`leads.assigned_to`).
   *
   * 리드는 소유자·조직 관리자 말고 **배정된 담당자**도 봐야 한다 — M07 수용기준이
   * "리드 조회는 담당자 · 조직 권한을 따른다" 이고, 배정 기능(P-105) 자체가 그 전제다.
   * 이 필드가 없을 때 `modules/lead.ts` 의 SQL 스코프(`assigned_to = me` 허용)와
   * 여기 ACL 이 어긋나서, **목록에는 보이는데 상세는 403** 이 되는 상태였다.
   */
  assignedUserId?: string | null;
}

/**
 * 플랫폼 역할(reviewer|admin)만 가질 수 있는 능력.
 *
 * 집합으로 둔 이유: 새 능력을 추가하면서 "검증자 전용"을 깜빡해 기본 분기(switch)로
 * 흘려보내는 사고를 막는다. 검증/감사 계열은 여기에 **먼저** 넣어야 한다.
 */
const PLATFORM_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "evidence.review",
  "badge.issue",
  "badge.revoke",
  "audit.read",
  // 신고 처리와 콘솔 접근도 플랫폼 역할이다 (P-167 / P-160: 검증자 역할만 접근).
  "report.handle",
  "admin.access",
]);

const ORG_MANAGER_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>(["manager", "owner"]);

export function can(p: Principal, cap: Capability, target: CapabilityTarget = {}): boolean {
  if (!p.userId) return false;

  if (PLATFORM_CAPABILITIES.has(cap)) {
    return p.platformRole === "reviewer" || p.platformRole === "admin";
  }

  switch (cap) {
    // N-12: 본인만. 대상이 특정되지 않은 호출도 거부한다 — "누구의 프로필인지 모르는 수정"은 없다.
    case "profile.edit":
      return target.ownerUserId !== undefined && target.ownerUserId === p.userId;

    // 증거는 본인이 자기 것을 올린다. 대상이 생략되면 "내 증거"를 뜻한다.
    case "evidence.submit":
      return target.ownerUserId === undefined || target.ownerUserId === p.userId;

    // 조직 관리자의 영역. 소속 승인은 소속 배지의 근거가 되지만 프로필 소유권을 주지 않는다 (P-083).
    case "org.manage":
    case "org.member.verify":
      return isOrgManager(p, target.organizationId);

    // 고객 PII — 담당자(프로필 소유자) 또는 그 조직 관리자만. 플랫폼 역할은 위에서 걸러지지 않으므로
    // 여기로 내려오고, 아래 조건에 해당하지 않으면 false 가 된다 (의도된 동작, 위 주석 3번).
    case "lead.read":
      return (
        (target.ownerUserId !== undefined && target.ownerUserId === p.userId) ||
        // P-105: 배정된 담당자. 배정해 놓고 열지 못하면 배정 기능이 아무 뜻이 없다.
        (target.assignedUserId != null && target.assignedUserId === p.userId) ||
        isOrgManager(p, target.organizationId)
      );

    /**
     * 배정은 **읽기보다 좁다.** 담당자가 자기에게 온 리드를 다른 사람에게 넘기면
     * 책임 소재가 흐려지고, 조직 밖으로 리드를 옮길 길도 생긴다. 소유자와 조직 관리자만 한다.
     */
    case "lead.assign":
      return (
        (target.ownerUserId !== undefined && target.ownerUserId === p.userId) ||
        isOrgManager(p, target.organizationId)
      );

    default:
      // 능력이 추가됐는데 분기를 안 썼다면 **거부**가 기본값이다 (fail-closed).
      return false;
  }
}

/** 실패 시 던진다. 라우트 어댑터가 `forbidden:<cap>` 를 보고 403 으로 바꾼다. */
export function assertCan(p: Principal, cap: Capability, target: CapabilityTarget = {}): void {
  if (!can(p, cap, target)) {
    throw new Error(`forbidden:${cap}`);
  }
}

/**
 * 해당 조직의 관리자(manager|owner)이고 소속이 **활성**인가.
 *
 * `status='active'` 를 요구하는 이유: 초대 수락 전(pending)이나 퇴사(revoked) 상태의 행이
 * 남아 있어도 권한이 살아 있으면 안 된다 (P-084 — 퇴사 시 소속 효력은 즉시 끊긴다).
 */
export function isOrgManager(p: Principal, organizationId: string | null | undefined): boolean {
  if (!p.userId || !organizationId) return false;
  for (const m of p.memberships) {
    if (m.organizationId === organizationId && m.status === "active" && ORG_MANAGER_ROLES.has(m.role)) {
      return true;
    }
  }
  return false;
}
