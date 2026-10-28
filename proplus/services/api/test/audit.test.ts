/**
 * M12 감사로그 통합테스트 — **기록이 애플리케이션의 선의에 의존하지 않는지**를 본다
 * (N-6 · N-7 · N-13 / P-065 · P-073 · P-109 · P-171).
 *
 * 감사로그는 사고가 난 **뒤에** 읽는 유일한 기록이다. 그래서 두 가지가 코드가 아니라 DB 에 박혀 있어야 한다:
 *   1) 지워지지 않는다 (N-7) — `audit_logs` 의 `BEFORE UPDATE OR DELETE` 트리거.
 *   2) 검증 상태 변경은 모듈이 깜빡해도 남는다 (N-6) — `verifications` 의 AFTER INSERT 트리거.
 * 두 트리거 모두 단위테스트로는 확인할 수 없다. 실제 Postgres 에 **생 SQL 로** 부딪혀야 한다.
 *
 * 세 번째 주제는 반대 방향이다: 남기되 **PII 원문은 남기지 않는다**(N-13). 감사로그가
 * 가장 매력적인 PII 덩어리가 되면 그 자체가 사고 대상이 된다 (보안정책 §3).
 *
 * 실행 조건: 실제 Postgres 가 필요하다. 없으면 스위트 전체를 skip 한다 — 로컬에서 빨간색이 뜨면
 *   아무도 테스트를 돌리지 않게 되고, 그게 테스트가 없는 것보다 나쁘다.
 *
 * 정리에 대하여: `audit_logs` 는 append-only 이므로 이 테스트가 남긴 행은 **지우지 않는다**(지울 수도 없다).
 *   그래서 모든 단정은 이 실행이 만든 aggregate_id·correlation_id 로만 조회한다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "../src/lib/audit";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, pool, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as admin from "../src/modules/admin";
import * as lead from "../src/modules/lead";
import * as proof from "../src/modules/proof";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 리드 경로는 연락처를 암호화해 저장한다. 키가 없으면 그 테스트만 건너뛴다 (crypto.ts 는 평문 저장을 거부한다). */
const HAS_FIELD_KEY = Boolean(process.env.FIELD_KEY);

const T = { timeout: 20_000 };

describe.skipIf(!DB)("M12 감사로그 — append-only·트리거·접근사유 (실제 Postgres)", () => {
  let POLICY = "verification-2026-10-22";
  const createdUsers: string[] = [];
  /** `consent_records.subject_ref` — 리드가 CASCADE 로 사라진 뒤에 남는 동의 행을 지우기 위한 키. */
  const createdConsentRefs: string[] = [];

  beforeAll(async () => {
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
        // 증거를 먼저 지워야 users CASCADE 가 통과한다 (verifications·badges·files 는 거기서 CASCADE).
        await q(`DELETE FROM evidence WHERE submitted_by = ANY($1::uuid[])`, [createdUsers]);
        await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
      }
      if (createdConsentRefs.length > 0) {
        await q(`DELETE FROM consent_records WHERE subject_ref = ANY($1::text[])`, [createdConsentRefs]);
      }
    } finally {
      await closePool();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 픽스처
  // ───────────────────────────────────────────────────────────────────────────

  function ctxOf(userId: string | null): Ctx {
    return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
  }

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

  async function newProfile(userId: string): Promise<{ id: string; slug: string }> {
    const slug = `test-${randomUUID()}`;
    const row = await one<{ id: string }>(
      `INSERT INTO profiles (user_id, slug, display_name, published_at)
       VALUES ($1,$2,'테스트 전문가', now()) RETURNING id::text AS "id"`,
      [userId, slug],
    );
    return { id: must(row, "생성한 프로필").id, slug };
  }

  async function rawEvidence(profileId: string, userId: string): Promise<string> {
    const row = await one<{ id: string }>(
      `INSERT INTO evidence (subject_type, subject_id, evidence_type, source_type, submitted_by)
       VALUES ('profile',$1,'identity','user',$2) RETURNING id::text AS "id"`,
      [profileId, userId],
    );
    return must(row, "생성한 증거").id;
  }

  interface AuditRow {
    id: string;
    eventType: string;
    actorId: string | null;
    actorRole: string | null;
    aggregateType: string;
    aggregateId: string | null;
    payload: Record<string, unknown>;
    accessPurpose: string | null;
    correlationId: string | null;
  }

  const AUDIT_SELECT = `
    SELECT id::text            AS "id",
           event_type          AS "eventType",
           actor_id::text      AS "actorId",
           actor_role          AS "actorRole",
           aggregate_type      AS "aggregateType",
           aggregate_id::text  AS "aggregateId",
           payload_minimized   AS "payload",
           access_purpose      AS "accessPurpose",
           correlation_id      AS "correlationId"
      FROM audit_logs`;

  function auditFor(aggregateId: string): Promise<AuditRow[]> {
    return q<AuditRow>(`${AUDIT_SELECT} WHERE aggregate_id = $1 ORDER BY id`, [aggregateId]);
  }

  function auditForRequest(correlationId: string): Promise<AuditRow[]> {
    return q<AuditRow>(`${AUDIT_SELECT} WHERE correlation_id = $1 ORDER BY id`, [correlationId]);
  }

  /**
   * PII 탐지 패턴. 느슨하게 쓰면 uuid 안의 숫자열이 전화번호로 잡혀 테스트가 랜덤하게 깨진다 —
   * 그래서 이메일은 `@` 를 요구하고, 전화는 **구분자가 있는 모양**만 본다
   * (uuid 의 하이픈은 항상 4·8·12자리 경계에 있어 이 패턴에 걸리지 않는다).
   * 구분자 없는 번호는 아래에서 "우리가 넣은 값"을 직접 비교해 잡는다.
   */
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  const PHONE_RE = /\b0\d{1,2}[-\s]\d{3,4}[-\s]\d{4}\b/;

  /**
   * uuid 는 식별자이고 PII 가 아니다 — 감사로그가 담아야 하는 것이 바로 그것이다.
   * 그런데 숫자만으로 이루어진 uuid 조각은 전화번호 패턴에 걸릴 수 있다. 제거하지 않으면
   * 이 테스트가 uuid 운에 따라 몇백 번에 한 번 깨지고, 그런 테스트는 아무도 믿지 않는다.
   */
  function withoutIds(text: string): string {
    return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe("N-7: audit_logs 는 append-only 다 (데이터모델 §1)", () => {
    it(
      "INSERT 는 되고 UPDATE·DELETE 는 트리거가 거부한다",
      async () => {
        const marker = randomUUID();
        const inserted = must(
          await one<{ id: string }>(
            `INSERT INTO audit_logs (event_type, aggregate_type, aggregate_id, correlation_id)
             VALUES ('test.append_only','test', gen_random_uuid(), $1)
             RETURNING id::text AS "id"`,
            [marker],
          ),
          "기록한 감사 한 줄",
        );

        await expect(
          q(`UPDATE audit_logs SET event_type = 'tampered' WHERE id = $1`, [inserted.id]),
        ).rejects.toThrow(/append-only/);

        await expect(q(`DELETE FROM audit_logs WHERE id = $1`, [inserted.id])).rejects.toThrow(/append-only/);

        // 거부된 두 시도 뒤에도 원본이 그대로다.
        const rows = await auditForRequest(marker);
        expect(rows).toHaveLength(1);
        expect(must(rows[0], "감사 행").eventType).toBe("test.append_only");
      },
      T,
    );

    it(
      "한 행도 맞지 않는 UPDATE·DELETE 도 거부된다 (문장 단위 트리거)",
      async () => {
        // FOR EACH ROW 가 아니라 FOR EACH STATEMENT 인 것이 중요하다: 조건을 틀려 0행을 맞춘
        // 대량 UPDATE 도 "성공"으로 끝나지 않는다. 즉 수정 경로가 **없다**.
        await expect(
          q(`UPDATE audit_logs SET event_type = 'tampered' WHERE event_type = $1`, [`없는-값-${randomUUID()}`]),
        ).rejects.toThrow(/append-only/);
        await expect(
          q(`DELETE FROM audit_logs WHERE event_type = $1`, [`없는-값-${randomUUID()}`]),
        ).rejects.toThrow(/append-only/);
      },
      T,
    );
  });

  describe("N-6 / P-065: 검증 상태 변경은 애플리케이션과 무관하게 기록된다 (모듈명세 M04)", () => {
    it(
      "모듈을 쓰지 않은 생 INSERT 도 verification.<status> 이벤트를 남긴다",
      async () => {
        const reviewerId = await newUser("reviewer");
        const ownerId = await newUser();
        const profileId = (await newProfile(ownerId)).id;
        const evidenceId = await rawEvidence(profileId, ownerId);

        // 여기서 호출하는 것은 proof 모듈이 아니다. 트리거의 존재 이유가 바로 이 경로다 —
        // 누가 콘솔·스크립트·새 모듈에서 검증을 넣어도 기록은 남아야 한다.
        const vId = must(
          await one<{ id: string }>(
            `INSERT INTO verifications
               (evidence_id, method, reviewer_id, status, scope, verified_at, policy_version)
             VALUES ($1,'document_reviewed',$2,'verified','성명·생년 확인', now(), $3)
             RETURNING id::text AS "id"`,
            [evidenceId, reviewerId, POLICY],
          ),
          "생성한 검증",
        ).id;

        const rows = await auditFor(vId);
        expect(rows).toHaveLength(1);
        const row = must(rows[0], "검증 감사 행");
        expect(row.eventType).toBe("verification.verified");
        expect(row.aggregateType).toBe("verification");
        expect(row.actorId).toBe(reviewerId);
        // 사후에 "무엇이 어떤 근거로 바뀌었는가"를 복원하는 데 필요한 필드들 (M04 수용기준).
        expect(row.payload).toMatchObject({
          evidenceId,
          method: "document_reviewed",
          status: "verified",
          scope: "성명·생년 확인",
          policyVersion: POLICY,
        });
        // 반려 사유가 없는 전이에서도 키 자체는 남는다 — 없는 키와 null 은 조사에서 다른 의미다.
        expect(row.payload).toHaveProperty("reasonCode", null);
      },
      T,
    );

    it(
      "반려는 사유 코드까지 payload 에 담긴다",
      async () => {
        const reviewerId = await newUser("reviewer");
        const ownerId = await newUser();
        const evidenceId = await rawEvidence((await newProfile(ownerId)).id, ownerId);

        const vId = must(
          await one<{ id: string }>(
            `INSERT INTO verifications (evidence_id, method, reviewer_id, status, reason_code, policy_version)
             VALUES ($1,'document_reviewed',$2,'rejected','document_unreadable',$3)
             RETURNING id::text AS "id"`,
            [evidenceId, reviewerId, POLICY],
          ),
          "생성한 검증",
        ).id;

        const row = must((await auditFor(vId))[0], "반려 감사 행");
        expect(row.eventType).toBe("verification.rejected");
        expect(row.payload).toMatchObject({ status: "rejected", reasonCode: "document_unreadable" });
      },
      T,
    );

    it(
      "모듈 경로에서는 트리거 기록과 모듈 기록이 **둘 다** 남는다",
      async () => {
        const ownerId = await newUser();
        await newProfile(ownerId);
        const reviewerId = await newUser("reviewer");
        const owner = ctxOf(ownerId);
        const reviewer = ctxOf(reviewerId);

        const submitted = await proof.submitEvidence(owner, { evidenceType: "identity", sourceType: "user" });
        await proof.transition(reviewer, submitted.evidenceId, "under_review");
        const out = await proof.transition(reviewer, submitted.evidenceId, "verified", {
          method: "document_reviewed",
          scope: "성명·생년 확인",
        });

        // 트리거는 reviewer_id 만 안다. 당사자 철회·시스템 만료에는 reviewer 가 없으므로
        // 모듈이 actor 역할을 담은 한 줄을 더 남긴다 — 둘은 서로를 대체하지 않는다.
        const byVerification = (await auditFor(out.verificationId)).map((r) => r.eventType);
        expect(byVerification).toContain("verification.verified");

        const byEvidence = await auditFor(submitted.evidenceId);
        const transitioned = must(
          byEvidence.find((r) => r.eventType === "evidence.transitioned" && r.payload.to === "verified"),
          "모듈이 남긴 전이 기록",
        );
        expect(transitioned.actorRole).toBe("reviewer");
        expect(transitioned.actorId).toBe(reviewerId);
      },
      T,
    );
  });

  describe("N-13: 감사로그 payload 에 PII 원문이 없다 (보안정책 §3)", () => {
    it(
      "증거에 연락처를 적어 제출해도 그 요청의 감사 payload 에는 남지 않는다",
      async () => {
        const email = `pii-${randomUUID()}@example.test`;
        const phone = "010-1234-5678";

        const ownerId = await newUser();
        await newProfile(ownerId);
        const owner = ctxOf(ownerId);

        // claim 은 검증자가 읽어야 하는 내용이라 evidence 에 저장된다. 그게 감사로그로 **번지지 않는지**가 핵심이다.
        await proof.submitEvidence(owner, {
          evidenceType: "identity",
          sourceType: "user",
          claim: { contactEmail: email, note: `연락처 ${phone} 로 확인 가능합니다` },
        });

        const rows = await auditForRequest(owner.requestId);
        expect(rows.length).toBeGreaterThan(0);
        const text = JSON.stringify(rows.map((r) => r.payload));
        expect(text).not.toContain(email);
        expect(text).not.toContain(phone);
        expect(text).not.toContain(phone.replace(/-/g, ""));
        expect(withoutIds(text)).not.toMatch(EMAIL_RE);
        expect(withoutIds(text)).not.toMatch(PHONE_RE);
      },
      T,
    );

    it(
      "호출부가 실수로 PII 를 넘겨도 writeAudit 이 리댁션한다",
      async () => {
        // redact() 를 통과시키는 이유가 이것이다: 호출부가 무엇을 넘겼는지 몰라도 안전해야 한다.
        const email = `careless-${randomUUID()}@example.test`;
        const aggregateId = randomUUID();
        await writeAudit(pool(), {
          eventType: "test.redaction",
          aggregateType: "test",
          aggregateId,
          payload: { contactEmail: email, memo: `전화 010-9876-5432 로 연락`, nested: { email } },
          correlationId: randomUUID(),
        });

        const row = must((await auditFor(aggregateId))[0], "리댁션 확인용 감사 행");
        const text = JSON.stringify(row.payload);
        expect(text).not.toContain(email);
        expect(text).not.toContain("010-9876-5432");
        expect(text).toContain("[redacted");
      },
      T,
    );

    it.skipIf(!HAS_FIELD_KEY)(
      "비회원 상담 요청(리드)의 감사 payload 에도 이름·연락처가 없다",
      async () => {
        const ownerId = await newUser();
        const profile = await newProfile(ownerId);
        const email = `lead-${randomUUID()}@example.test`;
        const anon = ctxOf(null);

        const created = await lead.createLead(anon, profile.slug, {
          contactName: "박고객",
          contactKind: "email",
          contact: email,
          message: "010-1234-5678 로 연락 주세요",
          consents: [{ purpose: "service", granted: true, policyVersion: "privacy-2026-10-22" }],
        });
        createdConsentRefs.push(`lead:${created.id}`);

        const rows = await auditFor(created.id);
        expect(rows.length).toBeGreaterThan(0);
        const text = JSON.stringify(rows.map((r) => r.payload));
        expect(text).not.toContain(email);
        expect(text).not.toContain("박고객");
        expect(text).not.toContain("010-1234-5678");
        expect(withoutIds(text)).not.toMatch(EMAIL_RE);
        expect(withoutIds(text)).not.toMatch(PHONE_RE);
      },
      T,
    );
  });

  describe("P-073: 증거 원본 다운로드는 접근 사유와 함께 기록된다 (보안정책 §2)", () => {
    it(
      "접근 사유 없는 호출은 거부되고 아무 기록도 남지 않는다",
      async () => {
        const f = await evidenceFile();

        await expect(proof.downloadFile(f.owner, f.fileId)).rejects.toMatchObject({
          status: 400,
          code: "access_purpose_required",
        });
        await expect(proof.downloadFile(f.owner, f.fileId, "  ")).rejects.toMatchObject({
          code: "access_purpose_required",
        });

        // 목적 없는 조회가 거부되는 것만으로는 부족하다 — 거부 전에 URL 이 발급되지 않았다는 것까지 봐야 한다.
        expect(await auditFor(f.fileId)).toHaveLength(0);
      },
      T,
    );

    it(
      "당사자 다운로드가 누가·언제·무엇을·왜 로 남는다",
      async () => {
        const f = await evidenceFile();
        const purpose = "제출 내용 재확인";

        const out = await proof.downloadFile(f.owner, f.fileId, purpose);
        expect(out.url).toMatch(/sig=/);
        expect(out.expiresInSec).toBeGreaterThan(0);

        const row = must((await auditFor(f.fileId))[0], "다운로드 감사 행");
        expect(row.eventType).toBe("evidence.file.downloaded");
        expect(row.aggregateType).toBe("evidence_file");
        expect(row.actorId).toBe(f.ownerId);
        expect(row.actorRole).toBe("owner");
        expect(row.accessPurpose).toBe(purpose);
        // 값이 아니라 **키 집합**을 단정하는 이유: `redact()` 는 숫자만으로 된 uuid 를 전화번호 후보로
        // 보고 가릴 수 있다(의도적으로 과하게 가린다 — redact.ts 주석). 어느 증거였는지는
        // aggregate_id 로도 찾을 수 있으므로, 여기서 중요한 것은 "무엇을 담았고 무엇을 안 담았나"다.
        expect(Object.keys(row.payload).sort()).toEqual(["byteSize", "contentType", "evidenceId"]);
        expect(row.payload.byteSize).toBe(2048);
        // N-5/N-13: 객체 키가 감사로그에 남으면 로그를 읽을 수 있는 사람이 원본 경로를 얻는다.
        expect(JSON.stringify(row.payload)).not.toContain(f.objectKey);
      },
      T,
    );

    it(
      "검증자 다운로드도 같은 경로로 기록된다 (운영자 접근에 예외가 없다)",
      async () => {
        const f = await evidenceFile();
        const reviewerId = await newUser("reviewer");

        await proof.downloadFile(ctxOf(reviewerId), f.fileId, "검증 큐 서류 확인");

        const row = must((await auditFor(f.fileId))[0], "검증자 다운로드 감사 행");
        expect(row.actorId).toBe(reviewerId);
        expect(row.actorRole).toBe("reviewer");
        expect(row.accessPurpose).toBe("검증 큐 서류 확인");
      },
      T,
    );

    /** 증거 파일 한 건. 바이트는 스토리지에 쓰지 않는다 — 여기서 확인할 것은 감사 기록이고,
     *  로컬 드라이버의 기본 경로(/var/lib/proplus/storage)는 CI 러너가 쓸 수 없다. */
    async function evidenceFile(): Promise<{
      ownerId: string;
      owner: Ctx;
      evidenceId: string;
      fileId: string;
      objectKey: string;
    }> {
      const ownerId = await newUser();
      const profileId = (await newProfile(ownerId)).id;
      const evidenceId = await rawEvidence(profileId, ownerId);
      const objectKey = `evidence/${evidenceId}/${randomUUID().replace(/-/g, "")}`;
      const fileId = must(
        await one<{ id: string }>(
          `INSERT INTO evidence_files (evidence_id, object_key, content_type, byte_size, sha256)
           VALUES ($1,$2,'application/pdf',2048,$3) RETURNING id::text AS "id"`,
          [evidenceId, objectKey, "a".repeat(64)],
        ),
        "생성한 증거 파일",
      ).id;
      return { ownerId, owner: ctxOf(ownerId), evidenceId, fileId, objectKey };
    }
  });

  describe("P-171: 관리자 권한 변경이 기록된다 (M01 수용기준)", () => {
    it(
      "부여와 회수가 모두 남는다",
      async () => {
        const adminId = await newUser("admin");
        const targetId = await newUser();
        const adminCtx = ctxOf(adminId);

        const up = await admin.setPlatformRole(adminCtx, targetId, "reviewer");
        expect(up).toMatchObject({ from: "none", to: "reviewer" });
        const down = await admin.setPlatformRole(ctxOf(adminId), targetId, "none");
        expect(down).toMatchObject({ from: "reviewer", to: "none" });

        const rows = (await auditFor(targetId)).filter((r) => r.eventType === "admin.platform_role_changed");
        expect(rows).toHaveLength(2);
        expect(must(rows[0], "권한 부여 기록").payload).toMatchObject({ from: "none", to: "reviewer" });
        expect(must(rows[1], "권한 회수 기록").payload).toMatchObject({ from: "reviewer", to: "none" });
        expect(must(rows[0], "권한 부여 기록").actorId).toBe(adminId);
        expect(must(rows[0], "권한 부여 기록").actorRole).toBe("admin");
      },
      T,
    );

    it(
      "자기 권한 변경은 거부되고 기록도 남지 않는다",
      async () => {
        // 2인 규칙의 최소 형태다. 자기 역할을 바꿀 수 있으면 권한 상승의 가장 짧은 경로가 열린다.
        const adminId = await newUser("admin");
        await expect(admin.setPlatformRole(ctxOf(adminId), adminId, "reviewer")).rejects.toMatchObject({ status: 403 });
        expect(await auditFor(adminId)).toHaveLength(0);
      },
      T,
    );

    it(
      "검증자는 남의 권한을 올릴 수 없다 (admin.access 는 reviewer 에게도 열려 있다)",
      async () => {
        const reviewerId = await newUser("reviewer");
        const targetId = await newUser();

        await expect(admin.setPlatformRole(ctxOf(reviewerId), targetId, "admin")).rejects.toMatchObject({ status: 403 });

        const after = must(
          await one<{ platformRole: string }>(`SELECT platform_role AS "platformRole" FROM users WHERE id = $1`, [targetId]),
          "대상 사용자",
        );
        expect(after.platformRole).toBe("none");
        expect(await auditFor(targetId)).toHaveLength(0);
      },
      T,
    );
  });

  describe("P-109: 리드 내보내기가 감사로그에 남는다 (대량조회)", () => {
    it.skipIf(!HAS_FIELD_KEY)(
      "마스킹 내보내기도 기록되고, 연락처 포함은 접근 사유 없이는 거부된다",
      async () => {
        const ownerId = await newUser();
        const profile = await newProfile(ownerId);
        const email = `export-${randomUUID()}@example.test`;
        const created = await lead.createLead(ctxOf(null), profile.slug, {
          contactName: "박고객",
          contactKind: "email",
          contact: email,
          consents: [{ purpose: "service", granted: true, policyVersion: "privacy-2026-10-22" }],
        });
        createdConsentRefs.push(`lead:${created.id}`);

        const owner = ctxOf(ownerId);
        const masked = await lead.exportLeads(owner, { profileId: profile.id });
        expect(masked.count).toBe(1);
        expect(masked.includedContacts).toBe(false);

        const first = must((await exportAudits(owner.requestId))[0], "내보내기 감사 행");
        expect(first.actorId).toBe(ownerId);
        expect(first.accessPurpose).toBe("리드 목록 내보내기");
        expect(first.payload).toMatchObject({ count: 1, includedContacts: false });

        // 연락처를 꺼내려면 "왜"가 있어야 한다 (P-165). 사유 없는 대량 조회는 조사에서 쓸모가 없다.
        await expect(
          lead.exportLeads(owner, { profileId: profile.id, includeContact: true }),
        ).rejects.toMatchObject({ status: 400, code: "access_purpose_required" });
      },
      T,
    );

    it.skipIf(!HAS_FIELD_KEY)(
      "연락처 포함 내보내기는 사유와 함께 남고, 그 사유는 감사로그에서 읽힌다",
      async () => {
        const ownerId = await newUser();
        const profile = await newProfile(ownerId);
        const email = `export-${randomUUID()}@example.test`;
        const created = await lead.createLead(ctxOf(null), profile.slug, {
          contactName: "박고객",
          contactKind: "email",
          contact: email,
          consents: [{ purpose: "service", granted: true, policyVersion: "privacy-2026-10-22" }],
        });
        createdConsentRefs.push(`lead:${created.id}`);

        const owner = ctxOf(ownerId);
        const purpose = "담당자 변경에 따른 연락처 이관";
        const out = await lead.exportLeads(owner, { profileId: profile.id, includeContact: true, accessPurpose: purpose });

        expect(out.includedContacts).toBe(true);
        // 내보내기 결과에는 원문이 있다 — 그래서 기록이 필요한 것이다.
        expect(must(out.rows[0], "내보낸 리드").contact).toBe(email);

        const row = must((await exportAudits(owner.requestId))[0], "내보내기 감사 행");
        expect(row.accessPurpose).toBe(purpose);
        expect(row.payload).toMatchObject({ count: 1, includedContacts: true });
        // 기록은 "꺼냈다"를 증명하고, 꺼낸 내용 자체는 담지 않는다 (N-13).
        expect(JSON.stringify(row.payload)).not.toContain(email);
      },
      T,
    );

    async function exportAudits(correlationId: string): Promise<AuditRow[]> {
      const rows = await auditForRequest(correlationId);
      return rows.filter((r) => r.eventType === "lead.exported");
    }
  });
});
