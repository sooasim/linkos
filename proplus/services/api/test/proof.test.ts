/**
 * M04 Proof Engine 통합테스트 — **DB 가 혼자서 막는지**를 본다 (P-051 · P-057 · P-059 · P-063).
 *
 * 왜 단위테스트로 충분하지 않은가:
 *   `packages/domain` 의 전이·배지 테스트는 "모듈을 통해 들어온 요청"만 덮는다. 그런데
 *   전략 §2 의 비타협 원칙 절반은 CHECK 제약·트리거·뷰에 들어가 있고(0001_proplus_core.sql),
 *   그 이중화의 **존재 이유는 애플리케이션이 틀렸을 때**다. 그래서 이 파일은 일부러 모듈을
 *   우회해 생 SQL 로 위반을 시도하고, DB 가 거부하는지 확인한다.
 *   `canTransition()` 이 자기기재 승인을 막는 것은 이미 증명됐다 — 여기서 묻는 것은
 *   "그 함수를 건너뛴 INSERT 도 막히는가"다.
 *
 * 실행 조건: 실제 Postgres 가 필요하다. 로컬에는 없고 CI(.github/workflows/proplus-ci.yml)에만 있다.
 *   DB 가 없으면 스위트 전체를 skip 한다 — 로컬 `pnpm proplus:test` 가 빨간색이면 아무도
 *   테스트를 돌리지 않게 되고, 그게 테스트가 없는 것보다 나쁘다.
 *
 * 격리 원칙: 각 테스트가 자기 사용자·프로필·증거를 `randomUUID()` 로 만들고 **자기가 만든 것만** 조회한다.
 *   같은 DB 에 다른 에이전트의 찌꺼기가 남아 있어도, 반복 실행해도 결과가 같아야 한다.
 */

import { randomUUID } from "node:crypto";
import { DISPUTED_LABEL_KO, type VerificationMethod } from "@proplus/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as proof from "../src/modules/proof";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 모든 테스트의 타임아웃. CI 의 Postgres 서비스가 처음 깨어날 때 느릴 수 있다. */
const T = { timeout: 20_000 };

describe.skipIf(!DB)("M04 Proof Engine — DB 제약·트리거·뷰 (실제 Postgres)", () => {
  /** 마이그레이션에 시드된 검증 정책 버전. `verifications.policy_version` 이 NOT NULL 이다 (P-169). */
  let POLICY = "verification-2026-10-22";

  /** 테스트가 만든 사용자. 정리는 여기에 매달린 것을 CASCADE 로 지운다. */
  const createdUsers: string[] = [];

  beforeAll(async () => {
    // 멱등하다. CI 는 이미 두 번 돌렸지만, 로컬에서 DB 만 띄우고 테스트를 돌리는 경우를 위해 여기서도 부른다.
    await migrate();
    const row = await one<{ version: string }>(
      `SELECT version FROM policy_versions
        WHERE kind = 'verification' AND effective_at <= now()
        ORDER BY effective_at DESC LIMIT 1`,
    );
    if (row) POLICY = row.version;
  }, 60_000);

  afterAll(async () => {
    try {
      if (createdUsers.length > 0) {
        // `evidence.submitted_by` 와 `verifications.reviewer_id` 는 ON DELETE 절이 없어서 users 를 붙잡는다.
        // 그래서 users CASCADE 전에 증거를 먼저 지운다 — verifications·badges·appeals 는 거기서 CASCADE 된다.
        await q(`DELETE FROM evidence WHERE submitted_by = ANY($1::uuid[])`, [createdUsers]);
        await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
      }
    } finally {
      // 안 부르면 vitest 프로세스가 끝나지 않는다 (풀이 전역 변수에 살아 있다).
      await closePool();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 픽스처 — 고정 id·이메일을 쓰지 않는다. 같은 DB 에서 반복 실행해도 충돌하지 않아야 한다.
  // ───────────────────────────────────────────────────────────────────────────

  function ctxOf(userId: string | null): Ctx {
    return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
  }

  /** `one()` 은 null 을 돌려줄 수 있다. 테스트에서는 없는 순간 바로 실패하는 쪽이 디버깅에 낫다. */
  function must<T>(v: T | null | undefined, what: string): T {
    if (v === null || v === undefined) throw new Error(`${what} 를 찾지 못했다`);
    return v;
  }

  async function newUser(platformRole: "none" | "reviewer" | "admin" = "none"): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO users (email, platform_role) VALUES ($1,$2) RETURNING id::text AS "id"`,
      [`test-${randomUUID()}@example.test`, platformRole],
    );
    const id = must(row, "생성한 사용자").id;
    createdUsers.push(id);
    return id;
  }

  async function newProfile(userId: string): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO profiles (user_id, slug, display_name, published_at)
       VALUES ($1,$2,'테스트 전문가', now()) RETURNING id::text AS "id"`,
      [userId, `test-${randomUUID()}`],
    );
    return must(row, "생성한 프로필").id;
  }

  /**
   * 모듈을 **우회해** 증거 행을 직접 만든다. 제약·트리거가 혼자서 막는지 보려면
   * 모듈(= 올바른 경로)을 쓰면 안 된다 — 그러면 막은 주체가 누구인지 알 수 없다.
   */
  async function rawEvidence(profileId: string, userId: string, type = "identity"): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO evidence (subject_type, subject_id, evidence_type, source_type, submitted_by)
       VALUES ('profile',$1,$2,'user',$3) RETURNING id::text AS "id"`,
      [profileId, type, userId],
    );
    return must(row, "생성한 증거").id;
  }

  interface RawVerification {
    method: VerificationMethod;
    status: string;
    scope?: string | null;
    verifiedAt?: Date | null;
    expiresAt?: Date | null;
    reasonCode?: string | null;
    reviewerId?: string | null;
  }

  function insertVerification(evidenceId: string, v: RawVerification): Promise<unknown> {
    return q(
      `INSERT INTO verifications
         (evidence_id, method, status, scope, verified_at, expires_at, reason_code, reviewer_id, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        evidenceId,
        v.method,
        v.status,
        v.scope ?? null,
        v.verifiedAt ?? null,
        v.expiresAt ?? null,
        v.reasonCode ?? null,
        v.reviewerId ?? null,
        POLICY,
      ],
    );
  }

  async function rawVerification(evidenceId: string, v: RawVerification): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO verifications
         (evidence_id, method, status, scope, verified_at, expires_at, reason_code, reviewer_id, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id::text AS "id"`,
      [
        evidenceId,
        v.method,
        v.status,
        v.scope ?? null,
        v.verifiedAt ?? null,
        v.expiresAt ?? null,
        v.reasonCode ?? null,
        v.reviewerId ?? null,
        POLICY,
      ],
    );
    return must(row, "생성한 검증").id;
  }

  interface Verified {
    ownerId: string;
    profileId: string;
    reviewerId: string;
    owner: Ctx;
    reviewer: Ctx;
    evidenceId: string;
    verificationId: string;
    badgeId: string | null;
  }

  /** 정상 경로(모듈)로 증거 제출 → 검토 → 승인까지 통과시킨다. 배지가 발급된 상태를 돌려준다. */
  async function verifiedViaModules(
    opts: { type?: string; method?: VerificationMethod; scope?: string } = {},
  ): Promise<Verified> {
    const ownerId = await newUser();
    const profileId = await newProfile(ownerId);
    const reviewerId = await newUser("reviewer");
    const owner = ctxOf(ownerId);
    const reviewer = ctxOf(reviewerId);

    const submitted = await proof.submitEvidence(owner, {
      evidenceType: opts.type ?? "identity",
      sourceType: "user",
    });
    await proof.transition(reviewer, submitted.evidenceId, "under_review");
    const out = await proof.transition(reviewer, submitted.evidenceId, "verified", {
      method: opts.method ?? "document_reviewed",
      scope: opts.scope ?? "성명·생년 확인",
    });

    return {
      ownerId,
      profileId,
      reviewerId,
      owner,
      reviewer,
      evidenceId: submitted.evidenceId,
      verificationId: out.verificationId,
      badgeId: out.badgeId,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe("N-1 / P-054: DB 제약이 모듈을 우회한 자기기재 승인을 막는다 (보안정책 §4.2)", () => {
    it(
      "verifications: method=self_declared + status=verified 는 CHECK 가 거부한다",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);
        const evidenceId = await rawEvidence(profileId, userId);

        // scope·verified_at 을 **채워서** 넣는다. 비워 두면 다른 CHECK 가 먼저 걸려
        // "무엇이 막았는가"를 단정할 수 없다.
        await expect(
          insertVerification(evidenceId, {
            method: "self_declared",
            status: "verified",
            scope: "본인이 적은 내용",
            verifiedAt: new Date(),
          }),
        ).rejects.toThrow(/verification_self_declared_never_verified/);
      },
      T,
    );

    it(
      "badges: 자기기재 배지 INSERT 는 거부된다 (트리거가 CHECK 보다 먼저 막는다)",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);
        const evidenceId = await rawEvidence(profileId, userId);
        // 자기기재는 verified 가 될 수 없으므로(위 테스트) 참조할 수 있는 self_declared 검증은
        // 확정 전 상태뿐이다. 그 상태의 검증으로 배지를 만들려는 시도가 실제 공격 모양에 가깝다.
        const vId = await rawVerification(evidenceId, { method: "self_declared", status: "needs_more_info", reasonCode: null });

        await expect(
          q(
            `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, status, verified_at)
             VALUES ($1,'identity',$2,'본인 확인 완료','self_declared','성명 확인','active', now())`,
            [profileId, vId],
          ),
        ).rejects.toThrow(/자기기재는 배지를 받을 수 없다|verified 검증만 참조할 수 있다/);
      },
      T,
    );

    it(
      "badge_never_self_declared CHECK 가 스키마에 남아 있다 (트리거가 사라져도 남는 두 번째 그물)",
      async () => {
        // 위 테스트에서 메시지를 낸 것은 BEFORE 트리거다 — Postgres 는 BEFORE 트리거를 CHECK 보다 먼저 돌린다.
        // 즉 이 CHECK 는 평소에 가려져 있고, 트리거가 드롭·수정되는 날에만 드러난다.
        // 그래서 "거부되는가"가 아니라 "제약이 아직 있는가"로 확인한다.
        const row = await one<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = 'badge_never_self_declared'`,
        );
        expect(Number(must(row, "pg_constraint 조회 결과").n)).toBe(1);
      },
      T,
    );

    it(
      "verified 가 아닌 verification 을 참조하는 badge 는 badges_require_verified 가 거부한다",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);
        const evidenceId = await rawEvidence(profileId, userId);
        const vId = await rawVerification(evidenceId, { method: "document_reviewed", status: "under_review" });

        await expect(
          q(
            `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, status, verified_at)
             VALUES ($1,'identity',$2,'본인 확인 완료','document_reviewed','성명 확인','active', now())`,
            [profileId, vId],
          ),
        ).rejects.toThrow(/verified 검증만 참조할 수 있다/);
      },
      T,
    );

    it(
      "badge.method 가 verification.method 와 다르면 같은 트리거가 거부한다",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);
        const evidenceId = await rawEvidence(profileId, userId);
        const vId = await rawVerification(evidenceId, {
          method: "issuer_confirmed",
          status: "verified",
          scope: "발급기관 확인",
          verifiedAt: new Date(),
        });

        // 강도를 더 세게 적는 것도, 약하게 적는 것도 안 된다 — 공개되는 강도는 검증 기록의 강도여야 한다.
        await expect(
          q(
            `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, status, verified_at)
             VALUES ($1,'identity',$2,'본인 확인 완료','document_reviewed','발급기관 확인','active', now())`,
            [profileId, vId],
          ),
        ).rejects.toThrow(/badge\.method/);
      },
      T,
    );
  });

  describe("P-056: verified 검증은 범위·기준일 없이 저장될 수 없다 (보안정책 §4.3)", () => {
    it(
      "scope 가 NULL 이면 CHECK 가 거부한다",
      async () => {
        const userId = await newUser();
        const evidenceId = await rawEvidence(await newProfile(userId), userId);
        await expect(
          insertVerification(evidenceId, { method: "document_reviewed", status: "verified", scope: null, verifiedAt: new Date() }),
        ).rejects.toThrow(/verification_verified_needs_scope_and_date/);
      },
      T,
    );

    it(
      "verified_at 이 NULL 이면 CHECK 가 거부한다",
      async () => {
        const userId = await newUser();
        const evidenceId = await rawEvidence(await newProfile(userId), userId);
        await expect(
          insertVerification(evidenceId, { method: "document_reviewed", status: "verified", scope: "성명 확인", verifiedAt: null }),
        ).rejects.toThrow(/verification_verified_needs_scope_and_date/);
      },
      T,
    );
  });

  describe("P-162 / P-061: 반려·취소에는 사유 코드가 필수다 (데이터모델 §4)", () => {
    it(
      "reason_code 없는 rejected 는 거부된다",
      async () => {
        const userId = await newUser();
        const evidenceId = await rawEvidence(await newProfile(userId), userId);
        await expect(
          insertVerification(evidenceId, { method: "document_reviewed", status: "rejected", reasonCode: null }),
        ).rejects.toThrow(/verification_rejected_needs_reason/);
      },
      T,
    );

    it(
      "reason_code 없는 revoked 는 거부된다",
      async () => {
        const userId = await newUser();
        const evidenceId = await rawEvidence(await newProfile(userId), userId);
        await expect(
          insertVerification(evidenceId, { method: "document_reviewed", status: "revoked", reasonCode: null }),
        ).rejects.toThrow(/verification_revoked_needs_reason/);
      },
      T,
    );

    it(
      "사유 코드가 있으면 통과한다 (제약이 정상 경로를 막지 않는다)",
      async () => {
        const userId = await newUser();
        const evidenceId = await rawEvidence(await newProfile(userId), userId);
        const vId = await rawVerification(evidenceId, {
          method: "document_reviewed",
          status: "rejected",
          reasonCode: "document_unreadable",
        });
        expect(vId).toMatch(/^[0-9a-f-]{36}$/);
      },
      T,
    );
  });

  describe("P-051: 증거 제출 → 검토 → 승인 → 배지 (모듈 경로)", () => {
    it(
      "제출은 status=submitted 로 시작하고 scope 는 아직 '주장'이다",
      async () => {
        const ownerId = await newUser();
        await newProfile(ownerId);
        const owner = ctxOf(ownerId);

        const out = await proof.submitEvidence(owner, {
          evidenceType: "identity",
          sourceType: "user",
          scope: "성명·생년 확인",
        });
        expect(out.status).toBe("submitted");

        const row = must(
          await one<{ status: string; claim: Record<string, unknown>; sourceType: string }>(
            `SELECT status, claim, source_type AS "sourceType" FROM evidence WHERE id = $1`,
            [out.evidenceId],
          ),
          "제출한 증거",
        );
        // 제출자가 시작 상태를 고를 수 없다는 것이 P-051 의 수용 기준이다.
        expect(row.status).toBe("submitted");
        expect(row.sourceType).toBe("user");
        // 확정된 범위는 검증자가 verified 전이에서 넣는다. 제출 시점의 범위는 claim 안에만 있다.
        expect(row.claim.scope).toBe("성명·생년 확인");

        // 당사자 조회 경로에도 아직 검증 결과가 없다.
        const mine = await proof.getMyEvidence(owner, out.evidenceId);
        expect(mine.latest).toBeNull();
      },
      T,
    );

    it(
      "검증자 승인이 배지를 만들고 listBadges 가 그것을 돌려준다",
      async () => {
        const v = await verifiedViaModules();
        expect(v.badgeId).not.toBeNull();

        const badges = await proof.listBadges(v.profileId);
        expect(badges).toHaveLength(1);
        const badge = must(badges[0], "공개 배지");
        expect(badge.id).toBe(v.badgeId);
        expect(badge.type).toBe("identity");
        // 라벨은 evidence_types.badge_label_ko 다 — 검증자가 자유 문구를 넣는 경로가 없다 (브랜드 §5).
        expect(badge.label).toBe("본인 확인 완료");
        expect(badge.method).toBe("document_reviewed");
        expect(badge.scope).toBe("성명·생년 확인");
        expect(badge.disputed).toBe(false);

        // 당사자 조회에도 검증 결과가 보인다. 검증자 신원·내부 메모는 포함되지 않는다 (P-164).
        const mine = await proof.getMyEvidence(v.owner, v.evidenceId);
        expect(mine.latest?.status).toBe("verified");
        expect(mine.latest?.method).toBe("document_reviewed");
        expect(Object.keys(mine.latest ?? {})).not.toContain("reviewerId");
      },
      T,
    );

    it(
      "owner 가 스스로 verified 로 전이하려 하면 거부된다 (actor 는 DB 사실로 정해진다)",
      async () => {
        const ownerId = await newUser();
        await newProfile(ownerId);
        const reviewerId = await newUser("reviewer");
        const owner = ctxOf(ownerId);
        const reviewer = ctxOf(reviewerId);

        const { evidenceId } = await proof.submitEvidence(owner, { evidenceType: "identity", sourceType: "user" });
        await proof.transition(reviewer, evidenceId, "under_review");

        // 강도와 범위를 "제대로" 적어도 통과하지 못해야 한다. 막는 것은 입력의 품질이 아니라 **자격**이다.
        await expect(
          proof.transition(owner, evidenceId, "verified", { method: "document_reviewed", scope: "성명·생년 확인" }),
        ).rejects.toMatchObject({ status: 400, code: "transition_not_allowed" });

        // 거부된 시도는 아무것도 남기지 않는다.
        const after = must(
          await one<{ status: string; badges: string }>(
            `SELECT e.status,
                    (SELECT count(*)::text FROM badges b
                       JOIN verifications v ON v.id = b.verification_id
                      WHERE v.evidence_id = e.id) AS badges
               FROM evidence e WHERE e.id = $1`,
            [evidenceId],
          ),
          "전이 시도 후 증거",
        );
        expect(after.status).toBe("under_review");
        expect(Number(after.badges)).toBe(0);
      },
      T,
    );
  });

  describe("P-059 / N-9: 만료가 읽기 시점에 반영된다 (배치 없이)", () => {
    it(
      "만료일을 과거로 바꾸면 아무 배치 없이도 공개 경로에서 사라진다",
      async () => {
        const v = await verifiedViaModules();
        const badgeId = must(v.badgeId, "발급된 배지");

        // 먼저 **미래** 만료로 두고 보인다는 것을 확인한다 — 안 그러면 뒤의 "안 보인다"가
        // 뷰의 만료 판정 때문인지 다른 조건 때문인지 구분되지 않는다.
        await q(`UPDATE badges SET expires_at = now() + interval '1 day' WHERE id = $1`, [badgeId]);
        expect(await viewRowCount(badgeId)).toBe(1);
        expect((await proof.listBadges(v.profileId)).map((b) => b.id)).toContain(badgeId);

        // 만료만 과거로 돌린다. status 는 손대지 않는다 — 워커가 돌지 않은 상황을 재현하는 것이다.
        await q(`UPDATE badges SET expires_at = now() - interval '1 day' WHERE id = $1`, [badgeId]);

        const stored = must(
          await one<{ status: string }>(`SELECT status FROM badges WHERE id = $1`, [badgeId]),
          "저장된 배지",
        );
        expect(stored.status).toBe("active"); // 아무 배치도 돌지 않았다

        expect(await viewRowCount(badgeId)).toBe(0);
        expect((await proof.listBadges(v.profileId, new Date())).map((b) => b.id)).not.toContain(badgeId);
      },
      T,
    );

    async function viewRowCount(badgeId: string): Promise<number> {
      const row = await one<{ n: string }>(`SELECT count(*)::text AS n FROM public_badge_view WHERE id = $1`, [badgeId]);
      return Number(must(row, "public_badge_view 집계").n);
    }
  });

  describe("P-057 / N-5: 공개 배지 조회는 증거 원본을 건드리지 않는다 (ADR-004)", () => {
    it(
      "배지 응답에 object_key·evidence_id 류 필드가 없다",
      async () => {
        const v = await verifiedViaModules();
        const objectKey = `evidence/${v.evidenceId}/${randomUUID().replace(/-/g, "")}`;
        await q(
          `INSERT INTO evidence_files (evidence_id, object_key, content_type, byte_size, sha256)
           VALUES ($1,$2,'application/pdf',2048,$3)`,
          [v.evidenceId, objectKey, "a".repeat(64)],
        );

        const badges = await proof.listBadges(v.profileId);
        const badge = must(badges[0], "공개 배지");

        // allowlist 를 **정확히** 단정한다. 블랙리스트("이 키는 없다")는 새 필드가 추가될 때 조용히 통과한다 (N-4).
        expect(Object.keys(badge).sort()).toEqual(
          [
            "disputed",
            "expiresAt",
            "id",
            "issuerName",
            "label",
            "method",
            "methodLabel",
            "scope",
            "type",
            "verifiedAt",
          ].sort(),
        );
        const serialized = JSON.stringify(badges);
        expect(serialized).not.toContain(objectKey);
        expect(serialized).not.toContain(v.evidenceId);
      },
      T,
    );

    it(
      "public_badge_view 자체에 증거 원본 컬럼이 없다",
      async () => {
        const cols = (
          await q<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'public_badge_view'`,
          )
        ).map((r) => r.column_name);
        expect(cols.length).toBeGreaterThan(0);
        // 뷰에 없는 컬럼은 공개될 길이 없다 — 그게 뷰를 쓰는 이유다.
        for (const forbidden of ["object_key", "evidence_id", "sha256", "reviewer_id", "verification_id"]) {
          expect(cols, `public_badge_view 에 ${forbidden} 이 있다`).not.toContain(forbidden);
        }
      },
      T,
    );
  });

  describe("P-066 / P-067 / N-8: 지표는 근거·표본 없이 공개되지 않는다 (보안정책 §4.8)", () => {
    it(
      "basis 가 빈 문자열이거나 sample_size 가 0 이면 저장은 되지만 공개 뷰에서 걸러진다",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);

        const emptyBasis = await insertMetric(profileId, { basis: "", sampleSize: 5 });
        const zeroSample = await insertMetric(profileId, { basis: "CRM 연동 데이터", sampleSize: 0 });
        const ok = await insertMetric(profileId, { basis: "CRM 연동 데이터. 취소 제외.", sampleSize: 128 });

        // NOT NULL 만으로는 ''·0 을 막을 수 없다. 그래서 **공개 경로**에서 거른다.
        const stored = await q<{ id: string }>(`SELECT id::text AS "id" FROM metric_claims WHERE profile_id = $1`, [profileId]);
        expect(stored.map((r) => r.id).sort()).toEqual([emptyBasis, zeroSample, ok].sort());

        const published = (
          await q<{ id: string }>(`SELECT id::text AS "id" FROM public_metric_view WHERE profile_id = $1`, [profileId])
        ).map((r) => r.id);
        expect(published).toEqual([ok]);
      },
      T,
    );

    it(
      "document_reviewed 검증을 근거로 쓰면 metric_claims_require_integration 이 거부한다",
      async () => {
        // 서류를 확인했다는 사실은 "거래가 128건 있었다"를 뒷받침하지 않는다 (기획서 §7 / P-067).
        const v = await verifiedViaModules();
        await expect(
          insertMetric(v.profileId, { basis: "직접 입력", sampleSize: 128, verificationId: v.verificationId }),
        ).rejects.toThrow(/system_integrated/);
      },
      T,
    );

    it(
      "system_integrated + verified 검증은 근거로 쓸 수 있고 공개 뷰가 verified=true 로 표시한다",
      async () => {
        const v = await verifiedViaModules({
          type: "transaction_count",
          method: "system_integrated",
          scope: "2026-01 ~ 2026-06 CRM 연동",
        });
        const id = await insertMetric(v.profileId, {
          basis: "CRM 연동 데이터. 계약 체결 건만. 취소·반품 제외.",
          sampleSize: 128,
          verificationId: v.verificationId,
        });

        const row = must(
          await one<{ id: string; verified: boolean }>(
            `SELECT id::text AS "id", verified FROM public_metric_view WHERE id = $1`,
            [id],
          ),
          "공개 지표",
        );
        expect(row.verified).toBe(true);
      },
      T,
    );

    async function insertMetric(
      profileId: string,
      m: { basis: string; sampleSize: number; verificationId?: string | null },
    ): Promise<string> {
      const row = await one<{ id: string }>(
        `INSERT INTO metric_claims
           (profile_id, metric_code, value_numeric, unit, period_start, period_end, sample_size, basis, verification_id)
         VALUES ($1,'contracts_closed',128,'건','2026-01-01','2026-06-30',$2,$3,$4)
         RETURNING id::text AS "id"`,
        [profileId, m.sampleSize, m.basis, m.verificationId ?? null],
      );
      return must(row, "생성한 지표").id;
    }
  });

  describe("P-063 / N-14: 이의제기는 배지를 숨기지 않고 중립화한다 (보안정책 §4.6)", () => {
    it(
      "당사자 이의제기가 상태를 disputed 로 돌리고 배지는 공개 뷰에 남는다",
      async () => {
        const v = await verifiedViaModules();
        const badgeId = must(v.badgeId, "발급된 배지");

        const appeal = await proof.submitAppeal(v.owner, v.verificationId, "소속 종료일이 실제와 다릅니다.");
        expect(appeal.evidenceStatus).toBe("disputed");

        const row = must(
          await one<{ status: string; verificationId: string }>(
            `SELECT status, verification_id::text AS "verificationId" FROM appeals WHERE id = $1`,
            [appeal.appealId],
          ),
          "접수된 이의제기",
        );
        expect(row.status).toBe("open");
        expect(row.verificationId).toBe(v.verificationId);

        // 숨기는 것이 아니라 중립화다. 분쟁 중 배지를 내려 버리면 "뭔가 있었다"는 사실 자체가 사라진다.
        const viewRow = must(
          await one<{ status: string }>(`SELECT status FROM public_badge_view WHERE id = $1`, [badgeId]),
          "공개 뷰의 분쟁 배지",
        );
        expect(viewRow.status).toBe("disputed");

        // 라벨 치환은 도메인이 한다 — 원래 라벨("본인 확인 완료")이 그대로 나가면 N-14 가 깨진다.
        const badges = await proof.listBadges(v.profileId);
        const badge = must(
          badges.find((b) => b.id === badgeId),
          "공개 배지 목록의 분쟁 배지",
        );
        expect(badge.disputed).toBe(true);
        expect(badge.label).toBe(DISPUTED_LABEL_KO);
      },
      T,
    );

    it(
      "이의제기는 당사자만 할 수 있다 (검증자 경로는 없다)",
      async () => {
        const v = await verifiedViaModules();
        // 자격이 없으면 404 다 — 남의 검증의 **존재 여부**도 알려 주지 않는다.
        await expect(proof.submitAppeal(v.reviewer, v.verificationId, "내 판정을 되돌리겠다")).rejects.toMatchObject({
          status: 404,
        });
      },
      T,
    );
  });

  describe("P-070 / N-2: 같은 유형의 활성 배지는 둘일 수 없다", () => {
    it(
      "badges_active_one_per_type 부분 UNIQUE 가 두 번째 활성 배지를 거부한다",
      async () => {
        const userId = await newUser();
        const profileId = await newProfile(userId);
        const first = await verifiedPair(profileId, userId);
        const second = await verifiedPair(profileId, userId);

        await insertActiveBadge(profileId, first);
        await expect(insertActiveBadge(profileId, second)).rejects.toThrow(/badges_active_one_per_type/);

        // 재검증은 이전 배지를 내린 뒤 발급한다 (P-062). 부분 인덱스이므로 expired 는 겹쳐도 된다.
        await q(`UPDATE badges SET status = 'expired' WHERE verification_id = $1`, [first]);
        await insertActiveBadge(profileId, second);

        const active = await q<{ id: string }>(
          `SELECT id::text AS "id" FROM badges WHERE profile_id = $1 AND badge_type = 'identity' AND status = 'active'`,
          [profileId],
        );
        expect(active).toHaveLength(1);
      },
      T,
    );

    async function verifiedPair(profileId: string, userId: string): Promise<string> {
      const evidenceId = await rawEvidence(profileId, userId);
      return rawVerification(evidenceId, {
        method: "document_reviewed",
        status: "verified",
        scope: "성명·생년 확인",
        verifiedAt: new Date(),
      });
    }

    function insertActiveBadge(profileId: string, verificationId: string): Promise<unknown> {
      return q(
        `INSERT INTO badges (profile_id, badge_type, verification_id, public_label, method, scope, status, verified_at)
         VALUES ($1,'identity',$2,'본인 확인 완료','document_reviewed','성명·생년 확인','active', now())`,
        [profileId, verificationId],
      );
    }
  });
});
