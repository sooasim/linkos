/**
 * P-009 역할 기반 권한 · P-083 소속 승인 · P-084 퇴사 처리 · P-103 리드 inbox(IDOR) · P-165 운영자 접근 사유
 *
 * 전략 §2 의 **N-12** 를 지키는 테스트다 (모듈명세 M05).
 * 핵심 단정은 둘이다:
 *   1. 조직 관리자도, 플랫폼 admin 도 **남의 `profile.edit` 를 못 한다** — 조직은 개인 프로필을 소유하지 않는다.
 *   2. 조직 권한은 **그 조직 안에서만** 작동한다 — 다른 조직 관리자의 통과는 테넌트 침범이다.
 */

import { describe, expect, it } from "vitest";
import { type Capability, type Principal, assertCan, can, isOrgManager } from "../src/acl";
import { type MemberRole } from "../src/types";

const SELF = "u-self";
const ORG_A = "org-a";
const ORG_B = "org-b";

function principal(over: Partial<Principal> = {}): Principal {
  return { userId: "u-x", platformRole: "none", memberships: [], ...over };
}

/**
 * 권한 매트릭스의 행(行). 실제 운영에서 나오는 7종 + 소속 상태 2종을 모두 세운다.
 * `self` 만 대상 리소스(`TARGET`)의 소유자다.
 */
const PRINCIPALS = {
  anon: principal({ userId: null }),
  self: principal({ userId: SELF }),
  member: principal({ userId: "u-other" }),
  orgMember: principal({
    userId: "u-m",
    memberships: [{ organizationId: ORG_A, role: "member", status: "active" }],
  }),
  orgManager: principal({
    userId: "u-mgr",
    memberships: [{ organizationId: ORG_A, role: "manager", status: "active" }],
  }),
  orgOwner: principal({
    userId: "u-own",
    memberships: [{ organizationId: ORG_A, role: "owner", status: "active" }],
  }),
  otherOrgManager: principal({
    userId: "u-mgr-b",
    memberships: [{ organizationId: ORG_B, role: "manager", status: "active" }],
  }),
  pendingManager: principal({
    userId: "u-pend",
    memberships: [{ organizationId: ORG_A, role: "manager", status: "pending" }],
  }),
  revokedManager: principal({
    userId: "u-rev",
    memberships: [{ organizationId: ORG_A, role: "manager", status: "revoked" }],
  }),
  reviewer: principal({ userId: "u-rv", platformRole: "reviewer" }),
  admin: principal({ userId: "u-ad", platformRole: "admin" }),
} satisfies Record<string, Principal>;

type PrincipalName = keyof typeof PRINCIPALS;

const PRINCIPAL_NAMES = Object.keys(PRINCIPALS) as PrincipalName[];

/** 대상: `self` 소유의 리소스, 조직 A 소속. */
const TARGET = { ownerUserId: SELF, organizationId: ORG_A };

/**
 * 능력별 **통과해야 하는 주체만** 적는다. 여기 없는 주체는 전부 거부가 기대값이다.
 * `Record<Capability, ...>` 라서 능력이 추가되면 컴파일이 깨진다 — 매트릭스에 구멍이 생기지 않는다.
 */
const ALLOWED: Record<Capability, readonly PrincipalName[]> = {
  // N-12: 본인만. 조직 관리자도 플랫폼 운영자도 없다.
  "profile.edit": ["self"],
  "evidence.submit": ["self"],
  // 검증 계열은 플랫폼 역할만 — 조직 관리자가 자기 직원을 '검증'하면 검증이 아니다 (보안정책 §4.4).
  "evidence.review": ["reviewer", "admin"],
  "badge.issue": ["reviewer", "admin"],
  "badge.revoke": ["reviewer", "admin"],
  // 조직의 영역. 해당 조직의 manager|owner 뿐이다 (P-083).
  "org.manage": ["orgManager", "orgOwner"],
  "org.member.verify": ["orgManager", "orgOwner"],
  // 고객 PII — 담당자 또는 그 조직 관리자. 플랫폼 역할은 감사 경로를 거쳐야 하므로 여기서는 거부다 (P-165).
  "lead.read": ["self", "orgManager", "orgOwner"],
  "lead.assign": ["self", "orgManager", "orgOwner"],
  "audit.read": ["reviewer", "admin"],
  "report.handle": ["reviewer", "admin"],
  "admin.access": ["reviewer", "admin"],
};

const CAPABILITIES = Object.keys(ALLOWED) as Capability[];

describe("P-009: 능력 × 주체 전수 매트릭스", () => {
  it("12개 능력 × 11개 주체 조합이 전부 기대값과 같다", () => {
    for (const cap of CAPABILITIES) {
      const allowed = ALLOWED[cap];
      for (const name of PRINCIPAL_NAMES) {
        const expected = allowed.includes(name);
        expect(can(PRINCIPALS[name], cap, TARGET), `${name} / ${cap}`).toBe(expected);
      }
    }
  });

  it("비로그인은 모든 능력에서 거부된다 — 공개 조회는 능력이 아니라 공개 뷰로 처리한다", () => {
    for (const cap of CAPABILITIES) {
      expect(can(PRINCIPALS.anon, cap, TARGET), cap).toBe(false);
      // 대상을 비워도, 조직만 줘도, 소유자만 줘도 마찬가지다.
      expect(can(PRINCIPALS.anon, cap), cap).toBe(false);
      expect(can(PRINCIPALS.anon, cap, { organizationId: ORG_A }), cap).toBe(false);
      expect(can(PRINCIPALS.anon, cap, { ownerUserId: SELF }), cap).toBe(false);
    }
  });

  it("평범한 회원은 남의 리소스에 대해 아무 능력도 없다", () => {
    for (const cap of CAPABILITIES) {
      expect(can(PRINCIPALS.member, cap, TARGET), cap).toBe(false);
    }
  });

  it("조직 일반 멤버(member)는 관리자 능력을 얻지 못한다", () => {
    expect(can(PRINCIPALS.orgMember, "org.manage", TARGET)).toBe(false);
    expect(can(PRINCIPALS.orgMember, "org.member.verify", TARGET)).toBe(false);
    expect(can(PRINCIPALS.orgMember, "lead.read", TARGET)).toBe(false);
  });
});

describe("P-009 / N-12: 조직도 플랫폼도 개인 프로필을 수정하지 못한다 (M05)", () => {
  it("조직 관리자는 소속 구성원의 profile.edit 을 못 한다", () => {
    // 승인 권한(org.member.verify)은 있지만 프로필 소유권은 따라오지 않는다 (P-083 수용기준).
    expect(can(PRINCIPALS.orgManager, "org.member.verify", TARGET)).toBe(true);
    expect(can(PRINCIPALS.orgManager, "profile.edit", TARGET)).toBe(false);
    expect(can(PRINCIPALS.orgOwner, "profile.edit", TARGET)).toBe(false);
  });

  it("플랫폼 admin 도 profile.edit 을 못 한다 — 운영자 경로가 아예 없다", () => {
    expect(can(PRINCIPALS.admin, "profile.edit", TARGET)).toBe(false);
    expect(can(PRINCIPALS.reviewer, "profile.edit", TARGET)).toBe(false);
    // 조직 관리자이면서 admin 인 경우에도 길이 열리지 않는다 (역할 합성으로 우회 불가).
    const superUser = principal({
      userId: "u-super",
      platformRole: "admin",
      memberships: [{ organizationId: ORG_A, role: "owner", status: "active" }],
    });
    expect(can(superUser, "profile.edit", TARGET)).toBe(false);
  });

  it("본인은 자기 프로필만 수정한다", () => {
    expect(can(PRINCIPALS.self, "profile.edit", { ownerUserId: SELF })).toBe(true);
    expect(can(PRINCIPALS.self, "profile.edit", { ownerUserId: "u-other" })).toBe(false);
  });

  it("대상이 특정되지 않은 profile.edit 은 거부한다 — '누구의 프로필인지 모르는 수정'은 없다", () => {
    expect(can(PRINCIPALS.self, "profile.edit")).toBe(false);
    expect(can(PRINCIPALS.self, "profile.edit", { organizationId: ORG_A })).toBe(false);
  });

  it("evidence.submit 은 대상이 생략되면 '내 증거'를 뜻한다", () => {
    expect(can(PRINCIPALS.self, "evidence.submit")).toBe(true);
    expect(can(PRINCIPALS.self, "evidence.submit", { ownerUserId: SELF })).toBe(true);
    expect(can(PRINCIPALS.self, "evidence.submit", { ownerUserId: "u-other" })).toBe(false);
  });
});

describe("P-083 / N-12: 조직 권한은 그 조직 안에서만 — 테넌트 침범 차단", () => {
  it("다른 조직의 관리자는 org.manage·org.member.verify 를 거부당한다", () => {
    expect(can(PRINCIPALS.otherOrgManager, "org.manage", { organizationId: ORG_A })).toBe(false);
    expect(can(PRINCIPALS.otherOrgManager, "org.member.verify", { organizationId: ORG_A })).toBe(false);
    // 자기 조직에서는 통과한다 — 거부의 이유가 역할이 아니라 조직임을 보인다.
    expect(can(PRINCIPALS.otherOrgManager, "org.manage", { organizationId: ORG_B })).toBe(true);
  });

  it("다른 조직 관리자는 그 조직의 리드를 읽지 못한다 (P-103 IDOR)", () => {
    expect(can(PRINCIPALS.otherOrgManager, "lead.read", TARGET)).toBe(false);
    expect(can(PRINCIPALS.otherOrgManager, "lead.assign", TARGET)).toBe(false);
  });

  it("조직이 특정되지 않은 조직 능력은 거부한다", () => {
    for (const cap of ["org.manage", "org.member.verify"] as Capability[]) {
      expect(can(PRINCIPALS.orgManager, cap), cap).toBe(false);
      expect(can(PRINCIPALS.orgManager, cap, { ownerUserId: SELF }), cap).toBe(false);
      expect(can(PRINCIPALS.orgManager, cap, { organizationId: "" }), cap).toBe(false);
    }
  });

  it("전수: 소속 상태 × 역할 조합에서 active 한 manager|owner 만 조직 권한을 가진다 (P-084)", () => {
    const statuses = ["pending", "active", "revoked", "", "ACTIVE"] as const;
    const roles: MemberRole[] = ["member", "manager", "owner"];
    for (const status of statuses) {
      for (const role of roles) {
        const p = principal({ userId: "u-t", memberships: [{ organizationId: ORG_A, role, status }] });
        const expected = status === "active" && role !== "member";
        expect(can(p, "org.manage", { organizationId: ORG_A }), `${status} / ${role}`).toBe(expected);
        expect(can(p, "org.member.verify", { organizationId: ORG_A }), `${status} / ${role}`).toBe(expected);
        expect(isOrgManager(p, ORG_A), `${status} / ${role}`).toBe(expected);
      }
    }
  });

  it("퇴사(revoked) 후에는 리드 조회 권한도 즉시 끊긴다", () => {
    expect(can(PRINCIPALS.revokedManager, "lead.read", TARGET)).toBe(false);
    expect(can(PRINCIPALS.pendingManager, "lead.read", TARGET)).toBe(false);
  });

  it("여러 소속 중 하나만 맞아도 그 조직에서는 관리자다", () => {
    const p = principal({
      userId: "u-multi",
      memberships: [
        { organizationId: ORG_B, role: "member", status: "active" },
        { organizationId: ORG_A, role: "manager", status: "active" },
      ],
    });
    expect(isOrgManager(p, ORG_A)).toBe(true);
    expect(isOrgManager(p, ORG_B)).toBe(false);
  });

  it("isOrgManager 는 비로그인·조직 미지정을 거부한다", () => {
    expect(isOrgManager(PRINCIPALS.anon, ORG_A)).toBe(false);
    expect(isOrgManager(PRINCIPALS.orgManager, null)).toBe(false);
    expect(isOrgManager(PRINCIPALS.orgManager, undefined)).toBe(false);
    expect(isOrgManager(PRINCIPALS.orgManager, "")).toBe(false);
    expect(isOrgManager(principal({ userId: "u-none", memberships: [] }), ORG_A)).toBe(false);
  });
});

describe("P-009: 검증·감사 계열은 플랫폼 역할(reviewer|admin)에서만 나온다", () => {
  const platformOnly: Capability[] = ["evidence.review", "badge.issue", "badge.revoke", "audit.read"];

  it("reviewer 와 admin 만 통과한다 — 대상이 무엇이든 조직 역할로는 열리지 않는다", () => {
    for (const cap of platformOnly) {
      expect(can(PRINCIPALS.reviewer, cap, TARGET), cap).toBe(true);
      expect(can(PRINCIPALS.admin, cap, TARGET), cap).toBe(true);
      for (const name of ["self", "member", "orgMember", "orgManager", "orgOwner"] as PrincipalName[]) {
        expect(can(PRINCIPALS[name], cap, TARGET), `${name} / ${cap}`).toBe(false);
      }
    }
  });

  it("플랫폼 능력은 대상 유무와 무관하게 역할만 본다", () => {
    for (const cap of platformOnly) {
      expect(can(PRINCIPALS.reviewer, cap), cap).toBe(true);
      expect(can(PRINCIPALS.reviewer, cap, { ownerUserId: "u-other" }), cap).toBe(true);
    }
  });

  it("platformRole='none' 은 플랫폼 능력을 갖지 못한다", () => {
    for (const cap of platformOnly) {
      expect(can(principal({ userId: "u-n", platformRole: "none" }), cap), cap).toBe(false);
    }
  });
});

describe("P-165: 고객 PII 는 플랫폼 역할로 열리지 않는다 (별도 감사 경로를 우회할 수 없다)", () => {
  it("admin·reviewer 는 lead.read 와 lead.assign 을 거부당한다", () => {
    for (const cap of ["lead.read", "lead.assign"] as Capability[]) {
      expect(can(PRINCIPALS.admin, cap, TARGET), cap).toBe(false);
      expect(can(PRINCIPALS.reviewer, cap, TARGET), cap).toBe(false);
    }
  });

  it("담당자 본인과 그 조직 관리자만 리드를 읽는다", () => {
    expect(can(PRINCIPALS.self, "lead.read", { ownerUserId: SELF })).toBe(true);
    expect(can(PRINCIPALS.orgManager, "lead.read", { organizationId: ORG_A })).toBe(true);
    expect(can(PRINCIPALS.member, "lead.read", { ownerUserId: SELF })).toBe(false);
  });

  it("대상이 비어 있으면 리드 능력도 거부한다 — '전체 리드 조회'라는 지름길이 없다", () => {
    expect(can(PRINCIPALS.self, "lead.read")).toBe(false);
    expect(can(PRINCIPALS.orgManager, "lead.read")).toBe(false);
  });
});

describe("P-009: 알 수 없는 능력과 assertCan 의 실패 형식", () => {
  it("능력 이름이 분기에 없으면 거부한다 (fail-closed)", () => {
    const bogus = "profile.delete" as Capability;
    for (const name of PRINCIPAL_NAMES) {
      expect(can(PRINCIPALS[name], bogus, TARGET), name).toBe(false);
    }
  });

  it("전수: 거부된 능력은 'forbidden:<cap>' 로 던진다", () => {
    for (const cap of CAPABILITIES) {
      expect(() => assertCan(PRINCIPALS.anon, cap, TARGET), cap).toThrow(`forbidden:${cap}`);
    }
  });

  it("허용된 능력은 던지지 않는다", () => {
    expect(() => assertCan(PRINCIPALS.self, "profile.edit", { ownerUserId: SELF })).not.toThrow();
    expect(() => assertCan(PRINCIPALS.reviewer, "evidence.review")).not.toThrow();
    expect(() => assertCan(PRINCIPALS.orgManager, "org.manage", { organizationId: ORG_A })).not.toThrow();
  });

  it("던지는 메시지에 사용자 식별자나 조직 식별자가 섞이지 않는다 (N-13: 로그에 PII 금지)", () => {
    try {
      assertCan(PRINCIPALS.self, "profile.edit", { ownerUserId: "u-other" });
      expect.unreachable("거부돼야 한다");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe("forbidden:profile.edit");
      expect(msg).not.toContain(SELF);
      expect(msg).not.toContain("u-other");
    }
  });
});

describe("P-103 / P-105: 배정된 담당자는 리드를 읽을 수 있고, 재배정은 못 한다", () => {
  // M07 수용기준: "리드 조회는 담당자 · 조직 권한을 따른다."
  // 이 분기가 없을 때 `modules/lead.ts` 의 SQL 스코프(assigned_to = me 허용)와 ACL 이 어긋나서
  // **목록에는 보이는데 상세는 403** 이 되는 상태였다. 두 곳이 같은 사실을 봐야 한다.
  const OWNER = "owner-user";
  const ASSIGNEE = "assignee-user";
  const STRANGER = "stranger-user";

  const plain = (userId: string): Principal => ({ userId, platformRole: "none", memberships: [] });

  const target = { ownerUserId: OWNER, assignedUserId: ASSIGNEE, organizationId: "org-1" };

  it("배정된 담당자는 읽을 수 있다", () => {
    expect(can(plain(ASSIGNEE), "lead.read", target)).toBe(true);
  });

  it("소유자는 읽을 수 있다", () => {
    expect(can(plain(OWNER), "lead.read", target)).toBe(true);
  });

  it("배정되지도 소유하지도 않은 사람은 읽지 못한다", () => {
    expect(can(plain(STRANGER), "lead.read", target)).toBe(false);
  });

  it("배정자가 없으면(null) 아무도 담당자 자격으로 읽지 못한다", () => {
    expect(can(plain(STRANGER), "lead.read", { ownerUserId: OWNER, assignedUserId: null })).toBe(false);
    // userId 가 null 인 비로그인 주체가 assignedUserId null 과 "같다"고 판정되면 안 된다.
    expect(can({ userId: null, platformRole: "none", memberships: [] }, "lead.read", { assignedUserId: null })).toBe(false);
  });

  it("담당자는 **재배정은 못 한다** — 책임 소재가 흐려지고 조직 밖으로 넘길 길이 생긴다", () => {
    expect(can(plain(ASSIGNEE), "lead.assign", target)).toBe(false);
    expect(can(plain(OWNER), "lead.assign", target)).toBe(true);
  });

  it("플랫폼 admin 은 여전히 고객 PII 를 이 능력으로 열지 못한다 (P-165 감사 경로 우회 금지)", () => {
    const admin: Principal = { userId: "ops", platformRole: "admin", memberships: [] };
    expect(can(admin, "lead.read", target)).toBe(false);
  });
});
