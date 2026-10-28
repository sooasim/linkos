/**
 * M12 Admin 통합테스트 — P-160 검토 큐 · P-161 승인 입력 · P-164 내부 메모 · P-165 접근 사유 ·
 * P-166 감사로그(N-7) · P-171 권한 변경.
 *
 * 왜 실제 DB 가 필요한가:
 *   이 모듈의 약속은 "조회를 거부한다"로 끝나지 않는다 — **거부·승인·조회가 감사로그에 남는가**가
 *   수용 기준이다(기술백서 §5 "목적·승인·시간 제한·감사로그"). 남았는지는 `audit_logs` 행을 읽어야
 *   알 수 있고, 그 테이블은 append-only 트리거(N-7)로 보호된다 — 트리거가 실제로 거부하는지도
 *   실제 Postgres 없이는 확인되지 않는다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 스위트 전체를 skip 한다.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as admin from "../src/modules/admin";
import * as profile from "../src/modules/profile";
import * as proof from "../src/modules/proof";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

const createdUsers: string[] = [];

function ctxFor(userId: string | null): Ctx {
  // `sessionId` 는 Ctx 의 필수 필드다 (P-003). 테스트 문맥에는 세션 행이 없다.
  return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
}

/** 역할은 **DB 사실**이다 (요청에 담겨 온 역할은 쓰이지 않는다). 그래서 사용자 행에 직접 심는다. */
async function newUser(platformRole: "none" | "reviewer" | "admin" = "none"): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO users (id, email, auth_provider, status, platform_role) VALUES ($1,$2,'email','active',$3)`,
    [id, `test-${id}@example.test`, platformRole],
  );
  createdUsers.push(id);
  return id;
}

interface Owner {
  userId: string;
  ctx: Ctx;
  profileId: string;
}

async function newOwner(): Promise<Owner> {
  const userId = await newUser();
  const ctx = ctxFor(userId);
  const created = await profile.createProfile(ctx, {
    slug: `ad-${randomUUID().slice(0, 18)}`,
    displayName: "검증 대상",
  });
  return { userId, ctx, profileId: created.id };
}

/** 증거는 **정책 경로로** 제출한다 (시드와 같은 원칙: 상태를 직접 심지 않는다). */
async function submitCareerEvidence(owner: Owner): Promise<string> {
  const { evidenceId } = await proof.submitEvidence(owner.ctx, {
    evidenceType: "career",
    sourceType: "user",
    scope: "2018-01 ~ 2024-12",
  });
  return evidenceId;
}

async function latestVerificationId(evidenceId: string): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT id::text AS id FROM verifications WHERE evidence_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [evidenceId],
  );
  expect(row?.id, "검증 행이 없다").toBeTruthy();
  return row?.id ?? "";
}

/**
 * 거부를 단정한다. `rejects.toThrow()` 는 메시지만 보므로 ApiError 의 `code`·`status` 까지 못 박는다 —
 * "권한이 없어서 막힌 것"과 "입력이 틀려서 막힌 것"을 구분하지 못하면 게이트 테스트가 의미를 잃는다.
 */
async function rejectedWith(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; status?: number },
  );
  expect(err, `거부되지 않았다 (기대 code=${code})`).not.toBeNull();
  expect(err?.code).toBe(code);
  if (status !== undefined) expect(err?.status).toBe(status);
}

describe.skipIf(!DB)("M12 Admin 통합 (실제 Postgres)", () => {
  beforeAll(async () => {
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length > 0) {
      // `evidence` 는 users CASCADE 로 지워지지 않는다(`submitted_by` 는 ON DELETE 가 없다).
      // 먼저 지우지 않으면 사용자 삭제가 FK 위반으로 실패한다. verifications·notes·appeals 는 함께 사라진다.
      await q(`DELETE FROM evidence WHERE submitted_by = ANY($1::uuid[])`, [createdUsers]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    // audit_logs 는 지우지 않는다 — append-only 라서 **지울 수 없다**(N-7). 그게 이 테이블의 요점이다.
    await closePool();
  }, 60_000);

  describe("P-165: 접근 사유 없는 운영자 조회는 거부된다", () => {
    it(
      "사유 없이 evidenceDetail 을 부르면 거부되고, 사유와 함께면 조회되며 그 사유가 감사로그에 남는다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);
        const reviewer = ctxFor(await newUser("reviewer"));

        // 목적 없는 조회는 **조회 자체가** 거부된다 (기술백서 §5 / 보안정책 §3).
        await rejectedWith(admin.evidenceDetail(reviewer, evidenceId), "access_purpose_required", 400);
        // 형식만 채운 값도 거부된다(빈 문자열·공백·너무 짧은 문구).
        await rejectedWith(admin.evidenceDetail(reviewer, evidenceId, "   "), "access_purpose_required", 400);
        await rejectedWith(admin.evidenceDetail(reviewer, evidenceId, "x"), "access_purpose_required", 400);

        // 거부된 조회는 감사로그를 남기지 않는다 — 조회가 일어나지 않았기 때문이다.
        const beforeLogs = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs WHERE event_type = 'admin.evidence_viewed' AND aggregate_id = $1`,
          [evidenceId],
        );
        expect(beforeLogs[0]?.n).toBe(0);

        const purpose = `이의제기 재심 검토-${randomUUID().slice(0, 8)}`;
        const detail = await admin.evidenceDetail(reviewer, evidenceId, purpose);
        expect(detail.evidenceId).toBe(evidenceId);
        expect(detail.evidenceType).toBe("career");
        expect(detail.subject.id).toBe(owner.profileId);

        const log = await one<{ eventType: string; actorId: string | null; actorRole: string | null; accessPurpose: string | null }>(
          `SELECT event_type AS "eventType", actor_id::text AS "actorId", actor_role AS "actorRole",
                  access_purpose AS "accessPurpose"
             FROM audit_logs
            WHERE event_type = 'admin.evidence_viewed' AND aggregate_id = $1
            ORDER BY occurred_at DESC, id DESC LIMIT 1`,
          [evidenceId],
        );
        expect(log?.accessPurpose).toBe(purpose);
        expect(log?.actorId).toBe(reviewer.userId);
        // 사후에 "누가 어떤 자격으로" 를 복원하려면 당시 역할이 필요하다.
        expect(log?.actorRole).toBe("reviewer");
      },
    );
  });

  describe("P-164: 검증자 내부 메모는 당사자에게 노출되지 않는다", () => {
    it(
      "메모를 남긴 뒤 당사자 경로의 반환에 메모 문자열이 없다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);
        const reviewerId = await newUser("reviewer");
        const reviewer = ctxFor(reviewerId);

        await proof.transition(reviewer, evidenceId, "under_review");
        const verificationId = await latestVerificationId(evidenceId);

        const note = `같은 서류가 다른 계정에서도 올라옴-${randomUUID()}`;
        const added = await admin.addReviewerNote(reviewer, verificationId, note);
        expect(added.noteId).toBeTruthy();

        // 당사자 경로. JSON 문자열로 바꿔 검사한다 — 중첩에 섞여 나오는 것까지 잡는다.
        const mine = await proof.getMyEvidence(owner.ctx, evidenceId);
        const mineJson = JSON.stringify(mine);
        expect(mineJson, "내부 메모가 당사자 조회에 들어갔다").not.toContain(note);
        // 검증자 신원도 당사자에게 나가지 않는다 (복수 검증자 운영의 전제다).
        expect(mineJson, "검증자 id 가 당사자 조회에 들어갔다").not.toContain(reviewerId);
        // 당사자에게 전달되는 것은 상태와 사유 코드다.
        expect(mine.status).toBe("under_review");
        expect(mine.latest?.status).toBe("under_review");

        const listJson = JSON.stringify(await proof.listMyEvidence(owner.ctx));
        expect(listJson).not.toContain(note);
        expect(listJson).not.toContain(reviewerId);

        // 양성 대조: 검증 콘솔 경로에서는 보인다. (여기서도 목적 기록이 필수다 — P-165)
        const detail = await admin.evidenceDetail(reviewer, evidenceId, "메모 확인을 위한 재검토");
        expect(JSON.stringify(detail.notes)).toContain(note);

        // 메모 본문은 감사로그로도 복사되지 않는다 — 내부 메모를 두 테이블에 퍼뜨리지 않는다.
        const logs = await q<{ payload: Record<string, unknown> }>(
          `SELECT payload_minimized AS payload FROM audit_logs
            WHERE event_type = 'admin.reviewer_note_added' AND aggregate_id = $1`,
          [verificationId],
        );
        expect(logs).toHaveLength(1);
        expect(JSON.stringify(logs[0]?.payload)).not.toContain(note);
        expect(logs[0]?.payload.length).toBe(note.length);
      },
    );
  });

  describe("P-160 / P-161: 검증자 역할과 승인 입력", () => {
    it(
      "검증자가 아닌 사용자는 검토 큐·증거 상세·승인 경로에 접근할 수 없다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);

        await rejectedWith(admin.reviewQueue(owner.ctx), "forbidden", 403);
        // 당사자라도 운영 콘솔 경로로는 자기 증거를 열 수 없다 (당사자 경로는 `proof.getMyEvidence` 다).
        await rejectedWith(admin.evidenceDetail(owner.ctx, evidenceId, "내 증거를 확인하고 싶다"), "forbidden", 403);
        await rejectedWith(admin.listAppeals(owner.ctx), "forbidden", 403);
        await rejectedWith(admin.reportQueue(owner.ctx), "forbidden", 403);

        // 당사자가 스스로 승인하는 경로는 전이표에 없다 (조직 관리자 경로도, 플랫폼 관리자 경로도 없다).
        await rejectedWith(
          proof.transition(owner.ctx, evidenceId, "verified", {
            method: "document_reviewed",
            scope: "스스로 승인 시도",
          }),
          "transition_not_allowed",
          400,
        );
        // 거부가 아무것도 쓰지 않았다.
        expect(
          (await q<{ n: number }>(`SELECT count(*)::int AS n FROM verifications WHERE evidence_id = $1`, [evidenceId]))[0]
            ?.n,
        ).toBe(0);
      },
    );

    it(
      "검증자는 큐를 보고 대기·처리중·완료가 상태별로 구분된다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);
        const reviewer = ctxFor(await newUser("reviewer"));

        const queue = await admin.reviewQueue(reviewer, { evidenceType: "career", limit: 200 });
        const item = queue.items.find((i) => i.evidenceId === evidenceId);
        expect(item, "제출한 증거가 검토 큐에 없다").toBeDefined();
        expect(item?.status).toBe("submitted");
        expect(item?.waitingHours).toBeGreaterThanOrEqual(0);
        expect(item?.minMethod).toBe("document_reviewed");

        // 큐는 "무엇을 처리해야 하는가"의 화면이다 — 이름·연락처는 담지 않는다 (P-165 경로에서만 본다).
        for (const key of ["subjectName", "displayName", "email", "phone", "claim"]) {
          expect(item, `큐 항목에 ${key} 가 있다`).not.toHaveProperty(key);
        }

        expect(Object.keys(queue.countsByStatus).length).toBeGreaterThan(0);
        expect(queue.countsByStatus["submitted"] ?? 0).toBeGreaterThanOrEqual(1);

        // 큐 열람도 기록된다 (보안정책 §2 관리자 오남용). 개인 데이터가 아니므로 목적은 요구하지 않는다.
        const viewed = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE event_type = 'admin.review_queue_viewed' AND actor_id = $1`,
          [reviewer.userId],
        );
        expect(viewed[0]?.n).toBeGreaterThanOrEqual(1);
      },
    );

    it(
      "승인에는 검증 강도와 범위가 필수다 — 빠지면 아무것도 쓰이지 않는다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);
        const reviewer = ctxFor(await newUser("reviewer"));

        await proof.transition(reviewer, evidenceId, "under_review");

        // 강도를 **명시하지 않으면** 기본값이 자기기재이고, 자기기재는 verified 가 될 수 없다 (N-1).
        await rejectedWith(
          proof.transition(reviewer, evidenceId, "verified", {}),
          "self_declared_cannot_verify",
          400,
        );
        // 강도만 있고 범위가 없으면 거부된다 (보안정책 §4.3: 검증에는 범위와 기준일이 있어야 한다).
        await rejectedWith(
          proof.transition(reviewer, evidenceId, "verified", { method: "document_reviewed" }),
          "scope_required",
          400,
        );
        // 유형이 요구하는 최소 강도보다 약한 방식도 거부된다.
        await rejectedWith(
          proof.transition(reviewer, evidenceId, "verified", { method: "self_declared", scope: "범위는 있다" }),
          "self_declared_cannot_verify",
          400,
        );

        const out = await proof.transition(reviewer, evidenceId, "verified", {
          method: "document_reviewed",
          scope: "2018-01 ~ 2024-12 재직 서류 확인",
        });
        expect(out.to).toBe("verified");
        expect(out.badgeId).toBeTruthy();

        // 거부된 세 번의 시도는 행을 남기지 않았다: under_review 1건 + verified 1건뿐이다.
        const statuses = (
          await q<{ status: string }>(
            `SELECT status::text AS status FROM verifications WHERE evidence_id = $1 ORDER BY created_at, id`,
            [evidenceId],
          )
        ).map((r) => r.status);
        expect(statuses).toEqual(["under_review", "verified"]);

        // 범위·기준일은 DB CHECK 로도 한 번 더 강제된다 — 모듈을 우회해도 같은 결과다.
        await expect(
          q(
            `INSERT INTO verifications (evidence_id, method, status, policy_version)
             VALUES ($1,'document_reviewed','verified','verification-2026-10-22')`,
            [evidenceId],
          ),
        ).rejects.toThrow(/verification_verified_needs_scope_and_date/);
        // N-1 도 DB 가 막는다: 자기기재 + verified 조합은 저장될 수 없다.
        await expect(
          q(
            `INSERT INTO verifications (evidence_id, method, status, scope, verified_at, policy_version)
             VALUES ($1,'self_declared','verified','범위', now(),'verification-2026-10-22')`,
            [evidenceId],
          ),
        ).rejects.toThrow(/verification_self_declared_never_verified/);
      },
    );

    it(
      "만료는 증거 유형의 기본 TTL 에서 파생된다 (승인 입력으로 강제되지 않는다)",
      { timeout: 30_000 },
      async () => {
        // `transaction_count` 는 min_method=system_integrated, default_ttl_days=180 인 유형이다.
        const owner = await newOwner();
        const submitted = await proof.submitEvidence(owner.ctx, {
          evidenceType: "transaction_count",
          sourceType: "third_party",
          scope: "2026-01 ~ 2026-06 CRM 연동",
        });
        const reviewer = ctxFor(await newUser("reviewer"));
        await proof.transition(reviewer, submitted.evidenceId, "under_review");

        // 유형이 요구하는 최소 강도보다 약하면 거부된다.
        await rejectedWith(
          proof.transition(reviewer, submitted.evidenceId, "verified", {
            method: "document_reviewed",
            scope: "서류만 봤다",
          }),
          "method_too_weak",
          400,
        );

        await proof.transition(reviewer, submitted.evidenceId, "verified", {
          method: "system_integrated",
          scope: "2026-01 ~ 2026-06 CRM 연동 데이터",
        });

        const v = await one<{ verified_at: Date | null; expires_at: Date | null }>(
          `SELECT verified_at, expires_at FROM verifications
            WHERE evidence_id = $1 AND status = 'verified' ORDER BY created_at DESC LIMIT 1`,
          [submitted.evidenceId],
        );
        expect(v?.verified_at).not.toBeNull();
        // 호출자가 만료를 넘기지 않았는데도 만료가 붙는다 → 만료의 출처는 `evidence_types.default_ttl_days` 다.
        expect(v?.expires_at).not.toBeNull();
        const ttlDays = ((v?.expires_at?.getTime() ?? 0) - (v?.verified_at?.getTime() ?? 0)) / 86_400_000;
        expect(ttlDays).toBeCloseTo(180, 1);
      },
    );
  });

  describe("P-171: 권한 변경", () => {
    it(
      "자기 자신의 platform_role 은 바꿀 수 없고, 남의 권한 변경은 감사로그에 남는다",
      { timeout: 30_000 },
      async () => {
        const adminId = await newUser("admin");
        const adminCtx = ctxFor(adminId);
        const target = await newUser();

        // 권한 상승의 가장 짧은 경로를 막는다 (2인 규칙의 최소 형태).
        await rejectedWith(admin.setPlatformRole(adminCtx, adminId, "admin"), "forbidden", 403);
        await rejectedWith(admin.setPlatformRole(adminCtx, adminId, "reviewer"), "forbidden", 403);

        // 검증자는 `admin.access` 능력이 있어도 역할을 **부여**할 수 없다.
        const reviewerCtx = ctxFor(await newUser("reviewer"));
        await rejectedWith(admin.setPlatformRole(reviewerCtx, target, "reviewer"), "forbidden", 403);
        expect(
          (await one<{ platform_role: string }>(`SELECT platform_role FROM users WHERE id = $1`, [target]))
            ?.platform_role,
        ).toBe("none");

        const out = await admin.setPlatformRole(adminCtx, target, "reviewer");
        expect(out).toEqual({ userId: target, from: "none", to: "reviewer" });

        const log = await one<{ payload: Record<string, unknown>; actorId: string | null }>(
          `SELECT payload_minimized AS payload, actor_id::text AS "actorId" FROM audit_logs
            WHERE event_type = 'admin.platform_role_changed' AND aggregate_id = $1
            ORDER BY id DESC LIMIT 1`,
          [target],
        );
        expect(log?.actorId).toBe(adminId);
        expect(log?.payload).toMatchObject({ from: "none", to: "reviewer" });

        // 같은 값으로 다시 바꾸는 것은 변경이 아니다(감사로그에 의미 없는 행을 쌓지 않는다).
        await rejectedWith(admin.setPlatformRole(adminCtx, target, "reviewer"), "role_unchanged", 409);
        await rejectedWith(admin.setPlatformRole(adminCtx, target, "superuser" as never), "role_invalid", 400);
      },
    );
  });

  describe("P-166 / N-7: 감사로그는 append-only 이고 조회는 읽기만 한다", () => {
    it(
      "UPDATE·DELETE 는 트리거가 거부한다 (한 행도 맞지 않아도 거부된다)",
      { timeout: 20_000 },
      async () => {
        // 트리거가 FOR EACH STATEMENT 이므로 "맞는 행이 없으니 통과"가 없다 — 문장 자체가 거부된다.
        await expect(q(`UPDATE audit_logs SET event_type = 'tampered' WHERE id = -1`)).rejects.toThrow(
          /append-only/,
        );
        await expect(q(`DELETE FROM audit_logs WHERE id = -1`)).rejects.toThrow(/append-only/);
        await expect(q(`UPDATE audit_logs SET access_purpose = NULL`)).rejects.toThrow(/append-only/);
      },
    );

    it(
      "auditTrail 은 기존 행을 바꾸지 않고, 검증자 권한이 없으면 볼 수 없다",
      { timeout: 30_000 },
      async () => {
        const owner = await newOwner();
        const evidenceId = await submitCareerEvidence(owner);
        const reviewer = ctxFor(await newUser("reviewer"));

        const snapshot = await q<{ id: string; event_type: string; occurred_at: Date }>(
          `SELECT id::text AS id, event_type, occurred_at FROM audit_logs
            WHERE aggregate_type = 'evidence' AND aggregate_id = $1 ORDER BY id`,
          [evidenceId],
        );
        // 제출 자체가 이미 기록돼 있다 (N-6: 모듈이 깜빡해도 남는다).
        expect(snapshot.length).toBeGreaterThanOrEqual(1);

        const entries = await admin.auditTrail(reviewer, "evidence", evidenceId);
        expect(entries.length).toBeGreaterThanOrEqual(snapshot.length);
        expect(entries.map((e) => e.eventType)).toContain("evidence.submitted");

        const after = await q<{ id: string; event_type: string; occurred_at: Date }>(
          `SELECT id::text AS id, event_type, occurred_at FROM audit_logs
            WHERE aggregate_type = 'evidence' AND aggregate_id = $1 ORDER BY id`,
          [evidenceId],
        );
        // 기존 행은 그대로이고, 조회 기록 한 줄이 **뒤에 덧붙었을** 뿐이다.
        expect(after.slice(0, snapshot.length)).toEqual(snapshot);
        expect(after.length).toBe(snapshot.length + 1);
        expect(after[after.length - 1]?.event_type).toBe("admin.audit_viewed");

        // 감사로그는 플랫폼 역할로만 열린다 (조직 역할로는 얻을 수 없는 능력이다).
        await rejectedWith(admin.auditTrail(owner.ctx, "evidence", evidenceId), "forbidden", 403);
      },
    );

    it(
      "admin 모듈에 audit_logs 를 수정·삭제하는 SQL 이 없다",
      { timeout: 20_000 },
      async () => {
        // "어떤 코드가 **없어야** 한다"는 규칙은 동작 테스트로 지킬 수 없다 — 잘못된 코드를 추가하는
        // 순간 깨지는데 그 코드에는 테스트가 따라오지 않는다. 그래서 소스를 읽는다
        // (`architecture.test.ts` 와 같은 방식).
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(resolve(here, "../src/modules/admin.ts"), "utf8")
          // 주석에는 규칙을 **설명하는** 문장이 있어 원문 그대로 검사하면 오탐이 된다.
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
        expect(src).not.toMatch(/UPDATE\s+audit_logs/i);
        expect(src).not.toMatch(/DELETE\s+FROM\s+audit_logs/i);
        expect(src).not.toMatch(/TRUNCATE\s+audit_logs/i);
        // 읽기는 한다(P-166) — 아예 접근이 없으면 위 단정이 공허해진다.
        expect(src).toMatch(/FROM\s+audit_logs/i);
      },
    );
  });
});
