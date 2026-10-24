/**
 * M01 Identity & Access — **DB 통합**테스트 (P-002 · P-003 · P-008 · P-011).
 *
 * 왜 이 파일이 따로 있는가:
 *   도메인 단위테스트는 순수 함수(토큰 생성·ACL·동의 검사)를 덮는다. 그러나
 *   "회전이 같은 세션 **행**을 UPDATE 하는가", "평문 토큰이 정말 DB 에 없는가",
 *   "정지된 계정의 쿠키가 세션 행을 지우지 않고도 막히는가", "동의가 목적마다 **한 행**인가"는
 *   실제 Postgres 에서만 답이 나온다. 이 파일은 그 경계만 본다 (전략 §9 테스트 피라미드).
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다 — .github/workflows/proplus-ci.yml). DB 가 없으면
 * **스위트 전체를 skip** 한다: 로컬 `pnpm proplus:test` 가 빨간색이 되면 아무도 테스트를 돌리지
 * 않게 되고, 그게 테스트가 없는 것보다 나쁘다.
 *
 * 격리 규칙: 각 테스트가 자기 데이터를 만들고 **자기가 만든 것만** 조회한다. 고정 id·고정 이메일을
 * 쓰지 않는 이유는 같은 DB 에서 반복 실행(로컬 재실행·CI 재시도)해도 충돌하지 않아야 하기 때문이다.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import type { ApiError } from "../src/lib/errors";
import { migrate } from "../src/migrate";
import * as identity from "../src/modules/identity";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 0001 마이그레이션이 시드한 정책 버전 (policy_versions). 동의 기록은 실재하는 버전을 가리켜야 한다 (P-169). */
const PRIVACY_POLICY = "privacy-2026-10-22";

/** 정리 대상. users CASCADE 가 sessions·consent_records·profiles 를 함께 지운다. */
const createdUsers: string[] = [];
const createdEmails: string[] = [];
/** 비회원 동의(user_id 가 없는 행)는 CASCADE 로 지워지지 않으므로 subject_ref 로 따로 지운다. */
const createdConsentSubjects: string[] = [];

function sha256(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/**
 * 테스트마다 다른 IP 를 쓴다. `consumeLoginLink` 는 IP 버킷으로 한도를 소비하고(P-004: 15분 5회),
 * 이 파일은 한도를 테스트하지 않는다 — 한 IP 를 공유하면 나중 테스트가 429 로 깨진다.
 */
function testIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function ctxFor(userId: string | null, ip = testIp()): Ctx {
  return { userId, sessionId: null, ip, userAgent: "vitest", requestId: randomUUID() };
}

function newEmail(): string {
  const email = `test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
}

/**
 * 거부 경로 단정용. 메시지 문구는 바뀔 수 있지만 `code` 는 응답 계약이므로(P-187) code 로 못 박는다.
 * (DB 제약 위반처럼 pg 가 던지는 에러는 제약 이름이 계약이므로 `rejects.toThrow(/제약이름/)` 을 쓴다.)
 */
async function rejectionOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("거부돼야 하는 호출이 성공했다");
}

interface Issued extends identity.SessionIssued {
  email: string;
  ip: string;
  /** 평문 로그인 토큰. DB 에 평문이 없다는 것을 확인하는 데 쓴다. */
  loginToken: string;
}

/**
 * 정책 경로를 그대로 지나 세션 하나를 만든다(매직링크 요청 → 소비). 계정은 **링크를 소비한 시점**에
 * 생기는 설계이므로(identity.ts 설계 전제 2) 이 경로가 사용자 생성 경로이기도 하다.
 *
 * 같은 `email` 을 넘기면 같은 계정에 세션이 하나 더 붙는다 — P-003(전체 폐기)에 필요하다.
 */
async function newSession(opts: { email?: string; ip?: string } = {}): Promise<Issued> {
  const email = opts.email ?? newEmail();
  const ip = opts.ip ?? testIp();
  const ctx = ctxFor(null, ip);

  const link = await identity.requestLoginLink(ctx, email);
  const loginToken = link.devLoginToken;
  if (!loginToken) {
    // SMTP_URL 이나 DEMO_LOGIN 이 설정된 환경에서는 토큰이 응답으로 나오지 않는다(의도된 동작).
    throw new Error("devLoginToken 이 비었다 — SMTP_URL·DEMO_LOGIN 이 설정된 환경에서는 이 스위트를 돌릴 수 없다");
  }
  const issued = await identity.consumeLoginLink(ctx, loginToken, { userAgent: "vitest" });
  if (!createdUsers.includes(issued.userId)) createdUsers.push(issued.userId);
  return { ...issued, email, ip, loginToken };
}

describe.skipIf(!DB)("M01 Identity & Access — DB 통합", () => {
  beforeAll(async () => {
    if (!DB) return;
    // 멱등하다. 스키마가 이미 올라가 있으면 빈 배열을 돌려준다 (P-181).
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (!DB) return;
    if (createdConsentSubjects.length > 0) {
      await q(`DELETE FROM consent_records WHERE subject_ref = ANY($1::text[])`, [createdConsentSubjects]);
    }
    if (createdUsers.length > 0) {
      // outbox_events 는 FK 가 없어 사용자를 지워도 남는다. 워커 테스트가 집어 가지 않게 함께 지운다.
      await q(`DELETE FROM outbox_events WHERE actor_id = ANY($1::uuid[])`, [createdUsers]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    if (createdEmails.length > 0) {
      // login_tokens 에는 user_id 가 없다(설계: 클릭 전에는 계정이 없다) — 이메일로 지운다.
      await q(`DELETE FROM login_tokens WHERE email = ANY($1::text[])`, [createdEmails]);
    }
    // audit_logs 는 지우지 않는다 — N-7 트리거가 DELETE 를 거부한다. rate_limits 는 해시 버킷만 남으므로 둔다.
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-002: 세션 쿠키 회전 (수용기준: 매 요청 회전, 평문 토큰 미저장)", () => {
    it(
      "회전은 새 토큰을 주고 옛 토큰을 즉시 무효화한다",
      async () => {
        const s = await newSession();

        const rotated = await identity.resolveSession(s.sessionToken, {}, true);
        expect(rotated).not.toBeNull();
        expect(rotated!.rotatedToken).toBeTruthy();
        expect(rotated!.rotatedToken).not.toBe(s.sessionToken);

        // 유출된 토큰의 유효 창을 좁히는 것이 회전의 목적이다 — 옛 토큰이 계속 통하면 회전은 장식이다.
        expect(await identity.resolveSession(s.sessionToken)).toBeNull();

        const next = await identity.resolveSession(rotated!.rotatedToken!);
        expect(next?.sessionId).toBe(s.sessionId);
        expect(next?.userId).toBe(s.userId);
      },
      20_000,
    );

    it(
      "회전은 **같은 세션 행을 UPDATE** 한다 (sessionId 가 변하지 않는다)",
      async () => {
        const s = await newSession();

        const r1 = await identity.resolveSession(s.sessionToken, {}, true);
        const r2 = await identity.resolveSession(r1!.rotatedToken!, {}, true);
        expect(r1!.sessionId).toBe(s.sessionId);
        expect(r2!.sessionId).toBe(s.sessionId);

        // 회전이 행을 새로 INSERT 하면 "이 기기의 세션"을 가리킬 수 없고, 로그아웃이 모든 기기를
        // 끊는 수밖에 없어진다 (lib/ctx.ts Ctx.sessionId 주석 / auth/logout 라우트).
        const rows = await q<{ id: string }>(`SELECT id FROM sessions WHERE user_id = $1`, [s.userId]);
        expect(rows.map((r) => r.id)).toEqual([s.sessionId]);

        // 그 사실에 로그아웃이 의존한다: 회전 두 번 뒤에도 최초의 sessionId 로 이 기기만 끊을 수 있다.
        await identity.revokeSession(ctxFor(s.userId), s.sessionId);
        expect(await identity.resolveSession(r2!.rotatedToken!)).toBeNull();
      },
      20_000,
    );

    it(
      "DB 에는 평문 토큰이 없다 (sha256 해시만)",
      async () => {
        const s = await newSession();

        const row = await one<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE id = $1`, [s.sessionId]);
        expect(row).not.toBeNull();
        expect(row!.token_hash).not.toBe(s.sessionToken);
        expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
        // 독립적으로 계산한 sha256 과 같다 = 저장된 값으로는 토큰을 복원할 수 없다 (보안정책 §2).
        expect(row!.token_hash).toBe(sha256(s.sessionToken));

        // 평문으로 조회하면 아무것도 나오지 않는다 — 덤프·로그에 평문이 섞여도 그것만으로는 조회가 안 된다.
        expect(await one(`SELECT id FROM sessions WHERE token_hash = $1`, [s.sessionToken])).toBeNull();

        // 로그인 링크 토큰도 같은 규칙이다 (P-001).
        const lt = await one<{ token_hash: string; used_at: Date | null }>(
          `SELECT token_hash, used_at FROM login_tokens WHERE email = $1`,
          [s.email],
        );
        expect(lt!.token_hash).toBe(sha256(s.loginToken));
        expect(lt!.used_at).not.toBeNull();
        expect(await one(`SELECT id FROM login_tokens WHERE token_hash = $1`, [s.loginToken])).toBeNull();
      },
      20_000,
    );

    it(
      "회전 뒤에도 평문 토큰은 DB 에 들어오지 않는다",
      async () => {
        const s = await newSession();
        const rotated = await identity.resolveSession(s.sessionToken, {}, true);
        const row = await one<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE id = $1`, [s.sessionId]);
        expect(row!.token_hash).toBe(sha256(rotated!.rotatedToken!));
        expect(row!.token_hash).not.toBe(rotated!.rotatedToken);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-003: 전체 세션 무효화 (수용기준: 계정 탈취 대응으로 모든 세션을 한 번에 폐기)", () => {
    it(
      "같은 사용자의 세션 3개가 전부 끊기고 다른 사용자는 영향받지 않는다",
      async () => {
        const a1 = await newSession();
        // 같은 주소 = 같은 계정이다(users.email UNIQUE). 같은 IP 를 재사용해야 P-004 한도(15분 5회) 안에 머문다.
        const a2 = await newSession({ email: a1.email, ip: a1.ip });
        const a3 = await newSession({ email: a1.email, ip: a1.ip });
        expect(new Set([a1.userId, a2.userId, a3.userId]).size).toBe(1);
        expect(new Set([a1.sessionId, a2.sessionId, a3.sessionId]).size).toBe(3);

        const other = await newSession();

        const { revoked } = await identity.revokeAllSessions(ctxFor(a1.userId));
        expect(revoked).toBe(3);

        for (const s of [a1, a2, a3]) {
          expect(await identity.resolveSession(s.sessionToken), `${s.sessionId} 가 아직 통한다`).toBeNull();
        }
        // 이게 빠지면 사고다: 한 사람의 탈취 대응이 다른 사람을 로그아웃시키면 안 된다.
        expect((await identity.resolveSession(other.sessionToken))?.sessionId).toBe(other.sessionId);

        const rows = await q<{ revoked_at: Date | null }>(`SELECT revoked_at FROM sessions WHERE user_id = $1`, [a1.userId]);
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
      },
      20_000,
    );

    it(
      "타인의 세션 폐기는 플랫폼 역할 + 접근 사유를 요구한다 (P-165)",
      async () => {
        const victim = await newSession();
        const attacker = await newSession();

        // 일반 사용자는 남의 세션을 폐기할 수 없다.
        const denied = await rejectionOf(
          identity.revokeAllSessions(ctxFor(attacker.userId), victim.userId, { accessPurpose: "호기심" }),
        );
        expect(denied.status).toBe(403);
        expect((await identity.resolveSession(victim.sessionToken))?.userId).toBe(victim.userId);

        // 운영 역할을 부여하는 API 경로가 아직 없으므로(P-009) 역할은 SQL 로 세운다.
        await q(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [attacker.userId]);
        const adminCtx = ctxFor(attacker.userId);

        // 사유 없는 타인 세션 폐기는 사후에 설명되지 않는다 — 그래서 막는다.
        const noPurpose = await rejectionOf(identity.revokeAllSessions(adminCtx, victim.userId));
        expect(noPurpose.code).toBe("access_purpose_required");
        expect((await identity.resolveSession(victim.sessionToken))?.userId).toBe(victim.userId);

        const ok = await identity.revokeAllSessions(adminCtx, victim.userId, { accessPurpose: "계정 탈취 신고 대응" });
        expect(ok.revoked).toBe(1);
        expect(await identity.resolveSession(victim.sessionToken)).toBeNull();

        const audit = await one<{ access_purpose: string | null }>(
          `SELECT access_purpose FROM audit_logs
            WHERE event_type = 'identity.all_sessions_revoked' AND aggregate_id = $1
            ORDER BY occurred_at DESC LIMIT 1`,
          [victim.userId],
        );
        expect(audit!.access_purpose).toBe("계정 탈취 신고 대응");
      },
      20_000,
    );

    it(
      "revokeSession 은 남의 세션을 지우지 못한다 (IDOR 차단)",
      async () => {
        const victim = await newSession();
        const attacker = await newSession();

        const err = await rejectionOf(identity.revokeSession(ctxFor(attacker.userId), victim.sessionId));
        // 소유자 조건이 WHERE 에 있으므로 "지울 게 없다"= 404 다. 403 이면 세션 id 의 존재가 드러난다.
        expect(err.status).toBe(404);

        expect((await identity.resolveSession(victim.sessionToken))?.sessionId).toBe(victim.sessionId);
        const row = await one<{ revoked_at: Date | null }>(`SELECT revoked_at FROM sessions WHERE id = $1`, [victim.sessionId]);
        expect(row!.revoked_at).toBeNull();
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-002: 만료·폐기·종류 불일치는 읽기 시점에 걸러진다", () => {
    it(
      "만료된 세션은 null 이다 (회전 경로도 같다)",
      async () => {
        const s = await newSession();
        await q(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);

        expect(await identity.resolveSession(s.sessionToken)).toBeNull();
        expect(await identity.resolveSession(s.sessionToken, {}, true)).toBeNull();
      },
      20_000,
    );

    it(
      "폐기된 세션은 null 이고, 회전도 거부된다",
      async () => {
        const s = await newSession();
        await q(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s.sessionId]);

        expect(await identity.resolveSession(s.sessionToken)).toBeNull();
        expect(await identity.resolveSession(s.sessionToken, {}, true)).toBeNull();
      },
      20_000,
    );

    it(
      "web 세션은 native 전용 경로에서 통하지 않는다",
      async () => {
        const s = await newSession();
        expect(await identity.resolveSession(s.sessionToken, {}, false, "native")).toBeNull();
        expect((await identity.resolveSession(s.sessionToken, {}, false, "web"))?.sessionId).toBe(s.sessionId);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-011: 정지·삭제된 계정의 기존 쿠키는 즉시 통하지 않는다", () => {
    it(
      "status='suspended' 면 세션 행을 지우지 않아도 막힌다",
      async () => {
        const s = await newSession();
        await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [s.userId]);

        expect(await identity.resolveSession(s.sessionToken)).toBeNull();

        // 요점은 **세션 행을 일일이 지우는 것에 의존하지 않는다**는 것이다. 행은 그대로 살아 있다.
        const row = await one<{ revoked_at: Date | null }>(`SELECT revoked_at FROM sessions WHERE id = $1`, [s.sessionId]);
        expect(row).not.toBeNull();
        expect(row!.revoked_at).toBeNull();

        // 권한 조립도 비로그인으로 떨어진다 (fail-closed).
        const principal = await identity.principalFor(s.userId);
        expect(principal.userId).toBeNull();
        expect(principal.platformRole).toBe("none");
      },
      20_000,
    );

    it(
      "deleted_at 이 채워지면 status 가 active 여도 막힌다",
      async () => {
        const s = await newSession();
        await q(`UPDATE users SET deleted_at = now() WHERE id = $1`, [s.userId]);

        expect(await identity.resolveSession(s.sessionToken)).toBeNull();
        expect((await identity.principalFor(s.userId)).userId).toBeNull();
      },
      20_000,
    );

    it(
      "삭제 요청은 공개를 끊고 세션을 폐기하고 외부에 알린다",
      async () => {
        const s = await newSession();
        // 프로필 생성 경로는 M02 테스트가 덮는다. 여기서 확인하는 것은 **삭제 요청이 공개를 끊는지**다.
        const prof = await one<{ id: string }>(
          `INSERT INTO profiles (user_id, slug, display_name, published_at)
           VALUES ($1,$2,'삭제요청 테스트', now()) RETURNING id`,
          [s.userId, `del-${randomUUID().slice(0, 8)}`],
        );

        const out = await identity.requestAccountDeletion(ctxFor(s.userId));
        expect(out.status).toBe("pending_erasure");
        expect(out.unpublishedProfiles).toBe(1);
        expect(out.revokedSessions).toBe(1);

        const after = await one<{ published_at: Date | null }>(`SELECT published_at FROM profiles WHERE id = $1`, [prof!.id]);
        expect(after!.published_at).toBeNull();
        expect(await identity.resolveSession(s.sessionToken)).toBeNull();

        // 외부(검색 색인·연동)가 공개 중단을 알아야 한다 — 같은 트랜잭션에 기록된다 (P-183).
        const events = await q<{ event_type: string }>(
          `SELECT event_type FROM outbox_events WHERE aggregate_type = 'profile' AND aggregate_id = $1`,
          [prof!.id],
        );
        expect(events.map((e) => e.event_type)).toContain("profile.unpublished");

        // 보존 대상은 남는다(행 삭제가 아니다) — 그래서 두 번째 요청은 "이미 삭제 요청됨"이다.
        const again = await rejectionOf(identity.requestAccountDeletion(ctxFor(s.userId)));
        expect(again.code).toBe("already_deleted");
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-008 / N-11: 동의는 목적마다 분리된 행이다", () => {
    it(
      "목적 3개를 기록하면 행 3개가 생기고 각 행에 policy_version 이 남는다",
      async () => {
        const s = await newSession();
        const ctx = ctxFor(s.userId);

        const out = await identity.recordConsents(ctx, [
          { purpose: "service", granted: true, policyVersion: PRIVACY_POLICY },
          { purpose: "marketing", granted: false, policyVersion: PRIVACY_POLICY },
          { purpose: "privacy", granted: true, policyVersion: PRIVACY_POLICY },
        ]);
        expect(out).toHaveLength(3);

        const rows = await q<{ purpose: string; granted: boolean; policy_version: string; ip_hash: string | null }>(
          // `ORDER BY purpose` 는 enum **정의 순서**(service, privacy, marketing, ...)로 정렬된다.
          // 테스트가 읽기 쉬우려면 사전순이어야 하므로 text 로 캐스팅한다.
          `SELECT purpose, granted, policy_version, ip_hash FROM consent_records WHERE user_id = $1 ORDER BY purpose::text`,
          [s.userId],
        );
        expect(rows.map((r) => r.purpose)).toEqual(["marketing", "privacy", "service"]);
        // 한 행에 여러 목적이 묶이지 않는다. 묶이면 "마케팅 동의만 철회"를 표현할 방법이 없고,
        // 그 순간 마케팅 동의가 서비스 이용의 조건이 된다 (보안정책 §3).
        expect(new Set(rows.map((r) => r.purpose)).size).toBe(rows.length);
        expect(rows.every((r) => r.policy_version === PRIVACY_POLICY)).toBe(true);
        expect(rows.find((r) => r.purpose === "marketing")!.granted).toBe(false);
        expect(rows.find((r) => r.purpose === "service")!.granted).toBe(true);

        // N-13: 원문 IP 는 어디에도 저장되지 않는다.
        expect(rows[0]!.ip_hash).toBeTruthy();
        expect(rows[0]!.ip_hash).not.toBe(ctx.ip);
      },
      20_000,
    );

    it(
      "같은 목적을 나중에 철회하면 새 행이 쌓이고 이전 기록이 사라지지 않는다",
      async () => {
        const s = await newSession();
        const ctx = ctxFor(s.userId);

        await identity.recordConsents(ctx, [{ purpose: "marketing", granted: true, policyVersion: PRIVACY_POLICY }]);
        await identity.recordConsents(ctx, [{ purpose: "marketing", granted: false, policyVersion: PRIVACY_POLICY }]);

        const rows = await q<{ granted: boolean }>(
          `SELECT granted FROM consent_records WHERE user_id = $1 AND purpose = 'marketing' ORDER BY created_at`,
          [s.userId],
        );
        // "언제 동의하고 언제 철회했는가"를 답할 수 있어야 동의 기록이 기록으로서 쓸모가 있다 (P-169).
        expect(rows.map((r) => r.granted)).toEqual([true, false]);
      },
      20_000,
    );

    it(
      "비회원 동의는 subject_ref 로 기록되고, 주체가 전혀 없으면 DB 가 거부한다",
      async () => {
        const subjectRef = `lead-${randomUUID()}`;
        createdConsentSubjects.push(subjectRef);

        const out = await identity.recordConsents(
          ctxFor(null),
          [{ purpose: "service", granted: true, policyVersion: PRIVACY_POLICY }],
          { subjectRef },
        );
        expect(out).toHaveLength(1);
        const row = await one<{ user_id: string | null; subject_ref: string | null }>(
          `SELECT user_id, subject_ref FROM consent_records WHERE subject_ref = $1`,
          [subjectRef],
        );
        expect(row!.user_id).toBeNull();
        expect(row!.subject_ref).toBe(subjectRef);

        // 모듈을 우회해도 주체 없는 동의는 저장되지 않는다 (consent_records 의 CHECK).
        await expect(
          q(`INSERT INTO consent_records (purpose, granted, policy_version) VALUES ('service', true, $1)`, [PRIVACY_POLICY]),
        ).rejects.toThrow(/violates check constraint/);
      },
      20_000,
    );

    it(
      "잘못된 동의 입력은 거부된다",
      async () => {
        const s = await newSession();
        const ctx = ctxFor(s.userId);

        expect((await rejectionOf(identity.recordConsents(ctx, []))).code).toBe("consents_required");
        expect(
          (await rejectionOf(identity.recordConsents(ctx, [{ purpose: "service", granted: true, policyVersion: "  " }])))
            .code,
        ).toBe("policy_version_required");
        expect(
          (
            await rejectionOf(
              identity.recordConsents(ctx, [
                // 런타임 입력은 타입을 지키지 않는다 — HTTP 본문으로 들어오는 값이기 때문이다.
                { purpose: "advertising" as never, granted: true, policyVersion: PRIVACY_POLICY },
              ]),
            )
          ).code,
        ).toBe("unknown_consent_purpose");
        expect(
          (
            await rejectionOf(
              identity.recordConsents(ctx, [
                { purpose: "marketing", granted: true, policyVersion: PRIVACY_POLICY },
                { purpose: "marketing", granted: false, policyVersion: PRIVACY_POLICY },
              ]),
            )
          ).code,
        ).toBe("consent_conflict");
        expect((await rejectionOf(identity.recordConsents(ctxFor(null), [{ purpose: "service", granted: true, policyVersion: PRIVACY_POLICY }]))).code).toBe(
          "consent_subject_required",
        );

        // 거부된 입력은 아무 행도 남기지 않는다.
        const rows = await q(`SELECT id FROM consent_records WHERE user_id = $1`, [s.userId]);
        expect(rows).toHaveLength(0);
      },
      20_000,
    );

    it(
      "enum 밖의 목적은 DB 가 거부한다 (모듈을 우회해도 같다)",
      async () => {
        const s = await newSession();
        await expect(
          q(`INSERT INTO consent_records (user_id, purpose, granted, policy_version) VALUES ($1, 'advertising', true, $2)`, [
            s.userId,
            PRIVACY_POLICY,
          ]),
        ).rejects.toThrow(/invalid input value for enum consent_purpose/);
      },
      20_000,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("P-001: 로그인 링크는 1회성이고 TTL 이 있다", () => {
    it(
      "같은 링크를 두 번 쓸 수 없다",
      async () => {
        const email = newEmail();
        const ctx = ctxFor(null);
        const link = await identity.requestLoginLink(ctx, email);
        const token = link.devLoginToken!;

        const issued = await identity.consumeLoginLink(ctx, token);
        createdUsers.push(issued.userId);

        // 만료·재사용·존재하지 않음을 구분하지 않는다 — 구분하면 유효한 토큰의 존재가 응답으로 드러난다.
        const err = await rejectionOf(identity.consumeLoginLink(ctx, token));
        expect(err.status).toBe(401);

        // 두 번째 시도로 세션이 하나 더 생기지 않았다.
        const rows = await q(`SELECT id FROM sessions WHERE user_id = $1`, [issued.userId]);
        expect(rows).toHaveLength(1);
      },
      20_000,
    );

    it(
      "TTL 이 지난 링크는 거부되고 계정도 만들어지지 않는다",
      async () => {
        const email = newEmail();
        const ctx = ctxFor(null);
        const link = await identity.requestLoginLink(ctx, email);
        const token = link.devLoginToken!;

        await q(`UPDATE login_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha256(token)]);

        expect((await rejectionOf(identity.consumeLoginLink(ctx, token))).status).toBe(401);
        // 계정은 링크를 **소비한 시점**에 생긴다 — 요청만 한 주소로는 계정이 생기지 않는다
        // (메일 폭탄이 users 테이블을 늘리지 못한다).
        expect(await one(`SELECT id FROM users WHERE email = $1`, [email])).toBeNull();
      },
      20_000,
    );

    it(
      "새 링크를 요청하면 이전 미사용 링크가 소모된다",
      async () => {
        const email = newEmail();
        const ctx = ctxFor(null);
        const first = (await identity.requestLoginLink(ctx, email)).devLoginToken!;
        const second = (await identity.requestLoginLink(ctx, email)).devLoginToken!;
        expect(second).not.toBe(first);

        // 살아 있는 링크가 여러 개면 유효 창이 TTL 이 아니라 "마지막 요청까지의 누적"이 된다.
        expect((await rejectionOf(identity.consumeLoginLink(ctx, first))).status).toBe(401);

        const issued = await identity.consumeLoginLink(ctx, second);
        createdUsers.push(issued.userId);
        expect(issued.sessionToken).toBeTruthy();
      },
      20_000,
    );
  });
});
