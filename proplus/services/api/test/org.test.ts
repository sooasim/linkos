/**
 * M05 Organization & Affiliation — **DB 통합**테스트 (P-081 · P-084 · P-086, 그리고 P-085).
 *
 * 이 파일의 주제는 전략 §2 **N-12**("조직은 개인 프로필을 소유하지 않는다") 한 줄이다.
 * 도메인 단위테스트(acl.ts)는 "조직 관리자에게 `profile.edit` 능력이 없다"를 증명했다. 여기서는
 * 실제 DB 를 끼고 그 결과가 **데이터에** 나타나는지를 본다:
 *   · 조직 관리자가 멤버십을 승인·취소할 수 있는가
 *   · 그 사람이 멤버의 프로필 행을 바꿀 수 있는 경로가 실제로 없는가
 *   · 소속 취소 뒤에 개인 프로필·개인 증거가 남고 **소속 배지만** 만료되는가 (P-084)
 *   · 조직 A 의 관리자가 조직 B 를 들여다볼 수 없는가 (P-086)
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 **스위트 전체를 skip** 한다 — 로컬
 * `pnpm proplus:test` 가 빨간색이면 아무도 테스트를 돌리지 않게 되고, 그게 테스트가 없는 것보다 나쁘다.
 *
 * 격리 규칙: 각 테스트가 자기 사용자·조직을 만들고 자기가 만든 것만 조회한다. 고정 slug·고정 이메일을
 * 쓰지 않으므로 같은 DB 에서 반복 실행해도 UNIQUE 제약과 부딪히지 않는다.
 */

import { createHash, randomUUID } from "node:crypto";
import { can, type MemberRole } from "@proplus/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q, tx } from "../src/lib/db";
import type { ApiError } from "../src/lib/errors";
import { migrate } from "../src/migrate";
import * as identity from "../src/modules/identity";
import * as org from "../src/modules/org";
import * as profile from "../src/modules/profile";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 0001 마이그레이션이 시드한 검증 정책 버전. verifications.policy_version 은 NOT NULL 이다 (P-169). */
const POLICY = "verification-2026-10-22";

const createdUsers: string[] = [];
const createdEmails: string[] = [];
const createdOrgs: string[] = [];
const createdIssuers: string[] = [];

function sha256(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/**
 * 사용자마다 다른 IP. 로그인 경로가 IP 버킷으로 한도를 소비하므로(P-004: 15분 5회)
 * 한 IP 를 공유하면 뒤의 테스트가 429 로 깨진다. 이 파일은 한도를 테스트하지 않는다.
 */
function testIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function newSlug(prefix = "t"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** 메시지 문구는 바뀔 수 있지만 status·code 는 응답 계약이다 (P-187). */
async function rejectionOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("거부돼야 하는 호출이 성공했다");
}

interface TestUser {
  userId: string;
  email: string;
  ctx: Ctx;
}

/** 계정은 매직링크를 소비한 시점에 생긴다(M01 설계). 즉 이것이 정책 경로의 사용자 생성이다. */
async function newUser(): Promise<TestUser> {
  const email = `test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  const ctx: Ctx = { userId: null, sessionId: null, ip: testIp(), userAgent: "vitest", requestId: randomUUID() };

  const link = await identity.requestLoginLink(ctx, email);
  if (!link.devLoginToken) {
    throw new Error("devLoginToken 이 비었다 — SMTP_URL·DEMO_LOGIN 이 설정된 환경에서는 이 스위트를 돌릴 수 없다");
  }
  const issued = await identity.consumeLoginLink(ctx, link.devLoginToken);
  createdUsers.push(issued.userId);
  return {
    userId: issued.userId,
    email,
    ctx: { ...ctx, userId: issued.userId, sessionId: issued.sessionId, requestId: randomUUID() },
  };
}

interface TestProfileUser extends TestUser {
  profileId: string;
  slug: string;
  displayName: string;
}

async function newUserWithProfile(displayName = "테스트 전문가"): Promise<TestProfileUser> {
  const user = await newUser();
  const slug = newSlug("p");
  const created = await profile.createProfile(user.ctx, { slug, displayName });
  return { ...user, profileId: created.id, slug: created.slug, displayName: created.displayName };
}

async function newOrg(owner: TestUser, name = "테스트 조직"): Promise<org.OrganizationView> {
  const view = await org.createOrganization(owner.ctx, { name, slug: newSlug("org") });
  createdOrgs.push(view.id);
  return view;
}

/** 도메인 검증을 처음부터 끝까지 지난다. 반환값은 검증된 도메인이다. */
async function verifyDomain(owner: TestUser, orgId: string): Promise<string> {
  const domain = `${newSlug("d")}.example`;
  const challenge = await org.startDomainVerification(owner.ctx, orgId, domain);
  const res = await org.confirmDomainVerification(owner.ctx, orgId, [challenge.recordValue]);
  expect(res.verified).toBe(true);
  return domain;
}

/** 초대 → 수락. 소속이 **활성**이 되는 정책 경로다 (P-082/P-083). */
async function addMember(owner: TestUser, orgId: string, member: TestUser, role: MemberRole = "member"): Promise<void> {
  const inv = await org.invite(owner.ctx, orgId, member.email, role);
  await org.acceptInvite(member.ctx, inv.token);
}

async function newIssuer(orgId: string, name: string): Promise<string> {
  const row = await one<{ id: string }>(
    // 발급 권한 확인 기록이 있어야 issuer_confirmed 를 쓸 수 있다 (P-072 / 보안정책 §4.4).
    `INSERT INTO issuers (name, kind, organization_id, authority_checked_at, authority_note)
     VALUES ($1,'company',$2, now(), '테스트: 발급 권한 확인 기록') RETURNING id`,
    [name, orgId],
  );
  createdIssuers.push(row!.id);
  return row!.id;
}

/**
 * 증거 → verified 검증 → 배지 사슬을 **그대로** 지나 배지 하나를 만든다 (db/seeds/seed.ts 와 같은 방식).
 *
 * 왜 M04 모듈 함수를 쓰지 않는가: 검증자 역할·업로드 세션·전이 관문은 M04 테스트의 주제이고,
 * 여기서 필요한 것은 "소속 배지가 존재하는 상태"다. 다만 **정책을 우회하지는 않는다** —
 * 사슬을 건너뛰면 `badges_require_verified_trg` 가 INSERT 를 거부하므로 우회 자체가 불가능하다.
 */
async function makeVerifiedBadge(opts: {
  profileId: string;
  submittedBy: string;
  organizationId: string | null;
  issuerId: string | null;
  issuerName: string | null;
  type: string;
  method: "document_reviewed" | "issuer_confirmed";
  scope: string;
  label: string;
}): Promise<{ evidenceId: string; verificationId: string; badgeId: string }> {
  return tx(async (c) => {
    const ev = await one<{ id: string }>(
      `INSERT INTO evidence (subject_type, subject_id, organization_id, evidence_type, issuer_id, source_type, claim, status, submitted_by)
       VALUES ('profile',$1,$2,$3,$4,$5,$6,'verified',$7) RETURNING id`,
      [
        opts.profileId,
        opts.organizationId,
        opts.type,
        opts.issuerId,
        opts.organizationId ? "organization" : "user",
        JSON.stringify({ scope: opts.scope }),
        opts.submittedBy,
      ],
      c,
    );
    const v = await one<{ id: string }>(
      `INSERT INTO verifications (evidence_id, method, status, scope, verified_at, policy_version)
       VALUES ($1,$2,'verified',$3, now() - interval '1 day', $4) RETURNING id`,
      [ev!.id, opts.method, opts.scope, POLICY],
      c,
    );
    const b = await one<{ id: string }>(
      `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, issuer_name, status, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active', now() - interval '1 day') RETURNING id`,
      [opts.profileId, opts.type, v!.id, opts.label, opts.method, opts.scope, opts.issuerName],
      c,
    );
    return { evidenceId: ev!.id, verificationId: v!.id, badgeId: b!.id };
  });
}

describe.skipIf(!DB)("M05 Organization & Affiliation — DB 통합", () => {
  beforeAll(async () => {
    if (!DB) return;
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (!DB) return;
    // 순서가 중요하다: evidence.submitted_by·memberships.verified_by 는 ON DELETE 가 없어
    // 사용자를 먼저 지우면 FK 위반이 난다. 증거 → 발급기관 → 조직(멤버십·초대 CASCADE) → 사용자.
    if (createdUsers.length > 0) {
      await q(`DELETE FROM evidence WHERE submitted_by = ANY($1::uuid[])`, [createdUsers]);
    }
    if (createdIssuers.length > 0) {
      await q(`DELETE FROM issuers WHERE id = ANY($1::uuid[])`, [createdIssuers]);
    }
    if (createdOrgs.length > 0) {
      await q(`DELETE FROM outbox_events WHERE tenant_id = ANY($1::uuid[])`, [createdOrgs]);
      await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [createdOrgs]);
    }
    if (createdUsers.length > 0) {
      await q(`DELETE FROM outbox_events WHERE actor_id = ANY($1::uuid[])`, [createdUsers]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    if (createdEmails.length > 0) {
      await q(`DELETE FROM login_tokens WHERE email = ANY($1::text[])`, [createdEmails]);
    }
    // audit_logs 는 지우지 않는다 — N-7 트리거가 DELETE 를 거부한다.
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-081: 도메인 소유 검증 (수용기준: 검증 전에는 소속 배지를 발급할 수 없다)", () => {
    it(
      "틀린 TXT 값으로는 검증되지 않고, 맞는 값이면 검증된다",
      async () => {
        const owner = await newUser();
        const o = await newOrg(owner, "도메인 검증 테스트");
        const domain = `${newSlug("d")}.example`;

        const challenge = await org.startDomainVerification(owner.ctx, o.id, domain);
        expect(challenge.recordType).toBe("TXT");
        expect(challenge.domain).toBe(domain);
        expect(challenge.recordHost).toBe(domain);
        // 다른 서비스의 검증 문자열이 우연히 통과하지 않도록 이름공간 접두사를 요구한다.
        expect(challenge.recordValue).toMatch(/^proplus-verify=.+/);

        // 틀린 값 · 무관한 TXT 가 섞여 있어도 검증되지 않는다. "아직 전파되지 않음"은 오류가 아니라 정상 상태다.
        const wrong = await org.confirmDomainVerification(owner.ctx, o.id, [
          "v=spf1 include:example.com ~all",
          "proplus-verify=틀린값",
        ]);
        expect(wrong.verified).toBe(false);
        expect(wrong.expected?.recordValue).toBe(challenge.recordValue);

        const pending = await one<{ domain_verified_at: Date | null; verified_domain: string | null }>(
          `SELECT domain_verified_at, verified_domain FROM organizations WHERE id = $1`,
          [o.id],
        );
        // 주장은 저장되지만 **검증 여부의 진실은 domain_verified_at** 이다 (org_domain_verified_pair CHECK 의 방향).
        expect(pending!.verified_domain).toBe(domain);
        expect(pending!.domain_verified_at).toBeNull();

        // resolver 가 따옴표로 감싸 주는 경우가 흔하다 — 그래도 통과해야 한다.
        const ok = await org.confirmDomainVerification(owner.ctx, o.id, [`"${challenge.recordValue}"`]);
        expect(ok.verified).toBe(true);
        expect(ok.alreadyVerified).toBe(false);
        expect(ok.domain).toBe(domain);

        const after = await one<{ domain_verified_at: Date | null; domain_challenge: string | null }>(
          `SELECT domain_verified_at, domain_challenge FROM organizations WHERE id = $1`,
          [o.id],
        );
        expect(after!.domain_verified_at).not.toBeNull();
        // challenge 는 역할을 다하면 지운다 — 남겨 두면 한 번 노출된 값이 계속 유효하다는 뜻이 된다.
        expect(after!.domain_challenge).toBeNull();

        // 재확인은 멱등하다(이미 검증됨).
        const again = await org.confirmDomainVerification(owner.ctx, o.id, []);
        expect(again).toMatchObject({ verified: true, alreadyVerified: true });
      },
      20_000,
    );

    it(
      "도메인 검증을 끝내지 않으면 소속을 확정할 수 없다 (= 소속 배지의 근거가 생기지 않는다)",
      async () => {
        const owner = await newUser();
        const member = await newUserWithProfile();
        const o = await newOrg(owner, "미검증 도메인 조직");

        // 도메인을 주장만 한 상태.
        const challenge = await org.startDomainVerification(owner.ctx, o.id, `${newSlug("d")}.example`);

        const inv = await org.invite(owner.ctx, o.id, member.email, "member");
        // 소속이 활성이 되는 두 경로를 모두 막는다 — 배지 쪽에만 가드를 두면 그 전에 이미
        // "조직이 확인한 소속"이 DB 에 남고 팀 페이지·검색·외부 연동이 그것을 믿는다.
        expect((await rejectionOf(org.acceptInvite(member.ctx, inv.token))).code).toBe("org_domain_unverified");
        expect((await rejectionOf(org.verifyMembership(owner.ctx, o.id, member.userId))).code).toBe(
          "org_domain_unverified",
        );

        const noMembership = await q(`SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2`, [
          o.id,
          member.userId,
        ]);
        expect(noMembership).toHaveLength(0);
        // 소속 배지도 당연히 없다.
        const badges = await q(`SELECT id FROM badges WHERE profile_id = $1`, [member.profileId]);
        expect(badges).toHaveLength(0);

        // 검증을 끝내면 같은 초대가 통한다.
        const ok = await org.confirmDomainVerification(owner.ctx, o.id, [challenge.recordValue]);
        expect(ok.verified).toBe(true);
        const joined = await org.acceptInvite(member.ctx, inv.token);
        expect(joined.organizationId).toBe(o.id);
      },
      20_000,
    );

    it(
      "이미 다른 조직이 검증한 도메인은 소속 근거로 가져갈 수 없다",
      async () => {
        const first = await newUser();
        const second = await newUser();
        const orgA = await newOrg(first, "도메인 선점 조직");
        const orgB = await newOrg(second, "도메인 추격 조직");

        const domain = await verifyDomain(first, orgA.id);

        // 같은 도메인을 두 조직이 소속 근거로 쓰면 소속 증명이 의미를 잃는다.
        const err = await rejectionOf(org.startDomainVerification(second.ctx, orgB.id, domain));
        expect(err.code).toBe("domain_taken");
        const row = await one<{ verified_domain: string | null }>(
          `SELECT verified_domain FROM organizations WHERE id = $1`,
          [orgB.id],
        );
        expect(row!.verified_domain).toBeNull();
      },
      20_000,
    );

    it(
      "domain_verified_at 만 채우고 verified_domain 을 비우면 DB 가 거부한다 (org_domain_verified_pair)",
      async () => {
        const owner = await newUser();
        const o = await newOrg(owner, "제약 확인 조직");

        await expect(
          q(`UPDATE organizations SET verified_domain = NULL, domain_verified_at = now() WHERE id = $1`, [o.id]),
        ).rejects.toThrow(/org_domain_verified_pair/);

        await expect(
          q(`INSERT INTO organizations (name, slug, domain_verified_at) VALUES ('제약 확인 조직 2', $1, now())`, [
            newSlug("org"),
          ]),
        ).rejects.toThrow(/org_domain_verified_pair/);

        // 반대 방향(도메인만 있고 검증시각 없음)은 허용된다 — 그것이 "주장만 한 상태"의 표현이다.
        await q(`UPDATE organizations SET verified_domain = $2 WHERE id = $1`, [o.id, `${newSlug("d")}.example`]);
        const row = await one<{ verified_domain: string | null; domain_verified_at: Date | null }>(
          `SELECT verified_domain, domain_verified_at FROM organizations WHERE id = $1`,
          [o.id],
        );
        expect(row!.verified_domain).not.toBeNull();
        expect(row!.domain_verified_at).toBeNull();
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("N-12 / P-083: 조직은 멤버십만 관여하고 개인 프로필을 소유하지 않는다", () => {
    it(
      "조직 관리자는 멤버십을 승인하고 취소할 수 있다",
      async () => {
        const owner = await newUser();
        const member = await newUserWithProfile();
        const o = await newOrg(owner, "멤버십 승인 조직");

        // `pending` 멤버십을 만드는 애플리케이션 경로는 아직 없다(초대 수락이 바로 active 다).
        // verifyMembership 의 대상은 그 pending 행이므로 테스트가 직접 만든다.
        await q(
          `INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1,$2,'member','pending')`,
          [o.id, member.userId],
        );

        const verified = await org.verifyMembership(owner.ctx, o.id, member.userId);
        expect(verified.userId).toBe(member.userId);
        expect(verified.status).toBe("active");
        expect(verified.effectiveActive).toBe(true);
        expect(verified.verifiedAt).not.toBeNull();

        const row = await one<{ verified_by: string; started_at: Date | null }>(
          `SELECT verified_by, started_at FROM memberships WHERE organization_id = $1 AND user_id = $2`,
          [o.id, member.userId],
        );
        // "누가 이 소속을 확정했나"를 항상 복원할 수 있어야 한다 (P-083).
        expect(row!.verified_by).toBe(owner.userId);
        expect(row!.started_at).not.toBeNull();

        // 승인은 소속 사실만 확정한다 — 배지는 만들지 않는다(그 사슬은 M04 가 가진다).
        expect(await q(`SELECT id FROM badges WHERE profile_id = $1`, [member.profileId])).toHaveLength(0);

        const revoked = await org.revokeMembership(owner.ctx, o.id, member.userId, "퇴사");
        expect(revoked.userId).toBe(member.userId);
        const after = await one<{ status: string; ended_at: Date | null }>(
          `SELECT status, ended_at FROM memberships WHERE organization_id = $1 AND user_id = $2`,
          [o.id, member.userId],
        );
        expect(after!.status).toBe("revoked");
        expect(after!.ended_at).not.toBeNull();
      },
      20_000,
    );

    it(
      "조직 관리자는 멤버의 프로필을 수정할 수 없다 (도달 가능한 행은 자기 프로필뿐이다)",
      async () => {
        const owner = await newUserWithProfile("관리자 본인");
        const member = await newUserWithProfile("멤버 본인");
        const o = await newOrg(owner, "프로필 소유 테스트");
        await addMember(owner, o.id, member);

        const before = await one<{ display_name: string; version: number }>(
          `SELECT display_name, version FROM profiles WHERE id = $1`,
          [member.profileId],
        );
        // 다른 테스트·과거 실행의 행과 섞이지 않게 이번 실행에서만 유일한 값을 쓴다.
        const newName = `조직이 바꾼 이름 ${randomUUID().slice(0, 8)}`;

        /*
         * `updateProfile` 에는 **대상 사용자 인자가 없다.** 조직 관리자 ctx 로 불러도 SQL 이 도달할 수 있는
         * 행은 `WHERE user_id = ctx.userId` 인 자기 프로필뿐이다.
         *
         * 호출의 성공/실패를 단정하지 않는 이유: 현재 M02 의 `writeProfile()` 이 런타임에 실패한다
         * (`UPDATE profiles ... public_settings = $9` 인데 바인딩 배열에 `region` 이 빠져 8개다 — 보고에 적었다).
         * 그 버그는 M02 의 주제이고, **이 테스트가 못 박는 것은 멤버의 프로필 행이 어떤 경우에도
         * 바뀌지 않는다는 것**이다. 버그가 고쳐지면 아래 "applied" 분기가 자기 프로필만 바뀌었음을 확인한다.
         */
        const outcome = await profile
          .updateProfile(owner.ctx, { displayName: newName })
          .then(() => "applied" as const, () => "rejected" as const);

        const memberAfter = await one<{ display_name: string; version: number }>(
          `SELECT display_name, version FROM profiles WHERE id = $1`,
          [member.profileId],
        );
        expect(memberAfter!.display_name).toBe(before!.display_name);
        expect(memberAfter!.version).toBe(before!.version);

        const changed = await q<{ user_id: string }>(`SELECT user_id FROM profiles WHERE display_name = $1`, [newName]);
        expect(changed.map((r) => r.user_id)).not.toContain(member.userId);
        if (outcome === "applied") {
          expect(changed.map((r) => r.user_id)).toEqual([owner.userId]);
        }

        // 프로필이 없는 조직 관리자는 고칠 대상이 아예 없다 — 남의 프로필로 떨어지지 않는다(404).
        const owner2 = await newUser();
        const o2 = await newOrg(owner2, "프로필 없는 관리자 조직");
        await addMember(owner2, o2.id, member);
        expect((await rejectionOf(profile.updateProfile(owner2.ctx, { displayName: newName }))).status).toBe(404);

        // 능력 자체가 없다: 조직 역할로는 `profile.edit` 로 가는 길이 acl.ts 에 없다.
        const principal = await identity.principalFor(owner.userId);
        expect(can(principal, "profile.edit", { ownerUserId: member.userId })).toBe(false);
        expect(can(principal, "profile.edit", { ownerUserId: owner.userId })).toBe(true);
        expect(can(principal, "org.member.verify", { organizationId: o.id })).toBe(true);
      },
      20_000,
    );

    it(
      "마지막 소유자의 소속은 취소할 수 없다 (조직이 관리 불가 상태가 되지 않게)",
      async () => {
        const owner = await newUser();
        const o = await newOrg(owner, "마지막 소유자 조직");
        const err = await rejectionOf(org.revokeMembership(owner.ctx, o.id, owner.userId, "본인 탈퇴"));
        expect(err.code).toBe("last_owner");

        const row = await one<{ status: string }>(
          `SELECT status FROM memberships WHERE organization_id = $1 AND user_id = $2`,
          [o.id, owner.userId],
        );
        expect(row!.status).toBe("active");
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-084: 소속 취소 — 소속 배지만 만료되고 개인 자산은 남는다", () => {
    it(
      "affiliation 배지만 만료되고 개인 프로필·개인 증거·다른 배지는 그대로다",
      async () => {
        const owner = await newUser();
        const member = await newUserWithProfile("퇴사자");
        const o = await newOrg(owner, "퇴사 처리 조직");
        await addMember(owner, o.id, member);
        const issuerId = await newIssuer(o.id, "퇴사 처리 조직");

        // 이 조직에서 나온 소속 배지
        const affiliation = await makeVerifiedBadge({
          profileId: member.profileId,
          submittedBy: member.userId,
          organizationId: o.id,
          issuerId,
          issuerName: "퇴사 처리 조직",
          type: "affiliation",
          method: "issuer_confirmed",
          scope: "2026년 재직 확인",
          label: "현재 소속 확인",
        });
        // 개인 경력 배지 — 조직과 무관하다. 퇴사가 이것까지 건드리면 "개인이 소유하는 신뢰 자산"이 아니게 된다.
        const career = await makeVerifiedBadge({
          profileId: member.profileId,
          submittedBy: member.userId,
          organizationId: null,
          issuerId: null,
          issuerName: null,
          type: "career",
          method: "document_reviewed",
          scope: "2015-03 ~ 재직 중",
          label: "경력 확인",
        });

        const result = await org.revokeMembership(owner.ctx, o.id, member.userId, "퇴사 — 2026-10 자진 퇴사");
        expect(result.badgesExpired).toBe(1);

        // N-9: 공개 조회는 읽기 시점에 만료를 판정한다. 배치 지연에 의존하지 않는다.
        const visible = await q<{ badge_type: string }>(
          `SELECT badge_type FROM public_badge_view WHERE profile_id = $1 ORDER BY badge_type`,
          [member.profileId],
        );
        expect(visible.map((r) => r.badge_type)).toEqual(["career"]);

        const affRow = await one<{ status: string; expires_at: Date | null }>(
          `SELECT status, expires_at FROM badges WHERE id = $1`,
          [affiliation.badgeId],
        );
        expect(affRow!.status).toBe("expired");
        expect(affRow!.expires_at).not.toBeNull();

        const careerRow = await one<{ status: string }>(`SELECT status FROM badges WHERE id = $1`, [career.badgeId]);
        expect(careerRow!.status).toBe("active");

        // 개인 프로필은 남는다 (N-12).
        const prof = await one<{ display_name: string }>(`SELECT display_name FROM profiles WHERE id = $1`, [
          member.profileId,
        ]);
        expect(prof!.display_name).toBe("퇴사자");

        // 개인 증거도 남는다 — 소속 증거까지 포함해서다(검증 이력은 분쟁 대응에 필요하다).
        const evidence = await q<{ id: string; status: string }>(
          `SELECT id, status FROM evidence WHERE subject_type = 'profile' AND subject_id = $1 ORDER BY submitted_at`,
          [member.profileId],
        );
        expect(evidence.map((e) => e.id).sort()).toEqual([affiliation.evidenceId, career.evidenceId].sort());

        // 외부 연동(CRM·팀 페이지·검색 색인)에 같은 트랜잭션에서 알린다 (P-183).
        const membership = await one<{ id: string }>(
          `SELECT id::text AS id FROM memberships WHERE organization_id = $1 AND user_id = $2`,
          [o.id, member.userId],
        );
        const events = await q<{ aggregate_id: string; payload: Record<string, unknown> }>(
          `SELECT aggregate_id::text AS aggregate_id, payload FROM outbox_events
            WHERE tenant_id = $1 AND event_type = 'membership.revoked'`,
          [o.id],
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.aggregate_id).toBe(membership!.id);
        // payload 의 문자열 값은 `redact()` 를 지나므로(N-13) 숫자 필드로 단정한다 — uuid 가 전화번호로
        // 오인돼 치환되는 경우가 드물게 있다(보고 참조).
        expect(events[0]!.payload).toMatchObject({ badgesExpired: 1 });
      },
      20_000,
    );

    it(
      "다른 조직의 소속 배지는 건드리지 않는다",
      async () => {
        const ownerA = await newUser();
        const ownerB = await newUser();
        const member = await newUserWithProfile("두 곳 소속");
        const orgA = await newOrg(ownerA, "소속 A");
        const orgB = await newOrg(ownerB, "소속 B");
        await addMember(ownerA, orgA.id, member);
        await addMember(ownerB, orgB.id, member);

        const issuerB = await newIssuer(orgB.id, "소속 B");
        // 같은 유형(affiliation)의 활성 배지는 프로필당 하나이므로(badges_active_one_per_type)
        // B 쪽 소속 배지만 세운다. 요점은 **A 에서 퇴사해도 B 의 배지가 살아 있는지**다.
        const badgeB = await makeVerifiedBadge({
          profileId: member.profileId,
          submittedBy: member.userId,
          organizationId: orgB.id,
          issuerId: issuerB,
          issuerName: "소속 B",
          type: "affiliation",
          method: "issuer_confirmed",
          scope: "2026년 재직 확인",
          label: "현재 소속 확인",
        });

        const result = await org.revokeMembership(ownerA.ctx, orgA.id, member.userId, "A 퇴사");
        expect(result.badgesExpired).toBe(0);

        const row = await one<{ status: string }>(`SELECT status FROM badges WHERE id = $1`, [badgeB.badgeId]);
        expect(row!.status).toBe("active");
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-086: 조직 멤버 목록 — 테넌트 침범 차단", () => {
    it(
      "조직 A 의 관리자는 조직 B 의 멤버를 조회할 수 없다",
      async () => {
        const a = await newUser();
        const b = await newUser();
        const orgA = await newOrg(a, "테넌트 A");
        const orgB = await newOrg(b, "테넌트 B");

        expect((await rejectionOf(org.listMembers(a.ctx, orgB.id))).status).toBe(403);
        // 조직 단건 조회는 403 이 아니라 404 다 — 403 은 "그 id 의 조직이 존재한다"를 알려 준다.
        expect((await rejectionOf(org.getOrganization(a.ctx, orgB.id))).status).toBe(404);

        // 자기 조직은 보인다.
        const own = await org.listMembers(a.ctx, orgA.id);
        expect(own.map((m) => m.userId)).toEqual([a.userId]);
        // N-13: 이메일 원문을 응답에 담지 않는다. 멤버 식별에는 마스킹으로 충분하다.
        expect(own[0]!.emailMasked).not.toBe(a.email);
        expect(own[0]!.emailMasked).toContain("***");
      },
      20_000,
    );

    it(
      "일반 멤버는 멤버 목록을 조회할 수 없다 (관리자만)",
      async () => {
        const owner = await newUser();
        const member = await newUser();
        const o = await newOrg(owner, "멤버 권한 조직");
        await addMember(owner, o.id, member);

        expect((await rejectionOf(org.listMembers(member.ctx, o.id))).status).toBe(403);
        // 자기 소속 사실은 볼 수 있다 — 조직 전체 명단과 다른 권한이다.
        const mine = await org.myOrganizations(member.ctx);
        expect(mine.map((x) => x.id)).toContain(o.id);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-085: ended_at 이 지난 소속은 읽기 시점에 비활성이다", () => {
    it(
      "status 는 active 여도 ended_at 이 과거면 효력이 없고 관리자 권한도 끊긴다",
      async () => {
        const owner = await newUser();
        const manager = await newUser();
        const o = await newOrg(owner, "소속 만료 조직");
        await addMember(owner, o.id, manager, "manager");

        expect(await org.listMembers(manager.ctx, o.id)).toHaveLength(2);

        await q(`UPDATE memberships SET ended_at = now() - interval '1 day' WHERE organization_id = $1 AND user_id = $2`, [
          o.id,
          manager.userId,
        ]);

        // 만료 배치가 늦게 돌아도 권한이 살아 있지 않아야 한다 — 그래서 status 는 그대로 'active' 다.
        const raw = await one<{ status: string }>(
          `SELECT status FROM memberships WHERE organization_id = $1 AND user_id = $2`,
          [o.id, manager.userId],
        );
        expect(raw!.status).toBe("active");

        const members = await org.listMembers(owner.ctx, o.id);
        expect(members.find((m) => m.userId === manager.userId)!.effectiveActive).toBe(false);
        expect(members.find((m) => m.userId === owner.userId)!.effectiveActive).toBe(true);

        // 당사자의 조직 관리 권한은 즉시 끊긴다 (acl.isOrgManager 는 'active' 만 인정하고,
        // loadPrincipal 이 ended_at 경과 행을 'revoked' 로 바꿔 넘긴다).
        expect((await rejectionOf(org.listMembers(manager.ctx, o.id))).status).toBe(403);

        const mine = await org.myOrganizations(manager.ctx);
        expect(mine.find((x) => x.id === o.id)!.effectiveActive).toBe(false);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-082: 초대 토큰은 해시 저장·1회성·TTL", () => {
    it(
      "DB 에는 해시만 남고 평문으로는 조회되지 않는다",
      async () => {
        const owner = await newUser();
        const member = await newUser();
        const o = await newOrg(owner, "초대 토큰 조직");

        const inv = await org.invite(owner.ctx, o.id, member.email, "member");
        const row = await one<{ token_hash: string; email: string }>(
          `SELECT token_hash, email FROM org_invites WHERE id = $1`,
          [inv.id],
        );
        expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row!.token_hash).toBe(sha256(inv.token));
        expect(row!.token_hash).not.toBe(inv.token);
        expect(await one(`SELECT id FROM org_invites WHERE token_hash = $1`, [inv.token])).toBeNull();

        // 응답에도 원문 이메일을 담지 않는다 (N-13).
        expect(inv.emailMasked).not.toBe(member.email);
        expect(inv.emailMasked).toContain("***");
      },
      20_000,
    );

    it(
      "같은 초대를 두 번 수락할 수 없다",
      async () => {
        const owner = await newUser();
        const member = await newUser();
        const o = await newOrg(owner, "1회성 초대 조직");

        const inv = await org.invite(owner.ctx, o.id, member.email, "member");
        await org.acceptInvite(member.ctx, inv.token);
        expect((await rejectionOf(org.acceptInvite(member.ctx, inv.token))).code).toBe("invite_used");

        const rows = await q(`SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2`, [
          o.id,
          member.userId,
        ]);
        expect(rows).toHaveLength(1);
      },
      20_000,
    );

    it(
      "만료된 초대는 거부되고 소속이 생기지 않는다",
      async () => {
        const owner = await newUser();
        const member = await newUser();
        const o = await newOrg(owner, "만료 초대 조직");

        const inv = await org.invite(owner.ctx, o.id, member.email, "member");
        await q(`UPDATE org_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [inv.id]);

        expect((await rejectionOf(org.acceptInvite(member.ctx, inv.token))).code).toBe("invite_expired");
        expect(await q(`SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2`, [o.id, member.userId])).toHaveLength(0);
      },
      20_000,
    );

    it(
      "링크를 가진 다른 계정은 소속을 주장할 수 없다 (초대 토큰은 bearer 다)",
      async () => {
        const owner = await newUser();
        const invited = await newUser();
        const stranger = await newUser();
        const o = await newOrg(owner, "bearer 방어 조직");

        const inv = await org.invite(owner.ctx, o.id, invited.email, "manager");
        // 소속은 공개 배지의 근거이므로 "링크를 가진 사람"보다 좁은 조건이 필요하다 (보안정책 §2).
        expect((await rejectionOf(org.acceptInvite(stranger.ctx, inv.token))).status).toBe(403);
        expect(await q(`SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2`, [o.id, stranger.userId])).toHaveLength(0);

        // 초대는 소모되지 않았으므로 정당한 수신자는 그대로 쓸 수 있다.
        const joined = await org.acceptInvite(invited.ctx, inv.token);
        expect(joined.role).toBe("manager");
      },
      20_000,
    );

    it(
      "새 초대를 보내면 이전 미사용 초대가 만료된다",
      async () => {
        const owner = await newUser();
        const member = await newUser();
        const o = await newOrg(owner, "초대 회수 조직");

        const first = await org.invite(owner.ctx, o.id, member.email, "member");
        const second = await org.invite(owner.ctx, o.id, member.email, "manager");
        expect(second.token).not.toBe(first.token);

        // org_invites 에 revoke 컬럼이 없으므로 `expires_at = now()` 가 회수의 역할을 한다.
        expect((await rejectionOf(org.acceptInvite(member.ctx, first.token))).code).toBe("invite_expired");
        expect((await org.acceptInvite(member.ctx, second.token)).role).toBe("manager");
      },
      20_000,
    );
  });
});
