/**
 * 트랜잭셔널 outbox 통합테스트 — P-183 (같은 트랜잭션) · P-184 (idempotent 소비)
 *
 * 왜 실제 Postgres 가 필요한가:
 *   P-183 은 "외부 연동을 유발하는 쓰기는 **같은 트랜잭션**에 기록된다"는 요구다. 이건 함수
 *   시그니처로 절반만 지켜진다(`enqueue(client: PoolClient, ...)` — architecture.test.ts 가 그 절반을
 *   본다). 나머지 절반, 즉 "롤백되면 이벤트도 함께 사라진다"는 **트랜잭션이 실제로 돌아야**
 *   확인된다. 그래서 여기서는 고의로 예외를 던져 롤백시키고, 도메인 쓰기와 이벤트가 둘 다
 *   없어졌는지 본다 — 둘이 같은 트랜잭션이라는 것을 이보다 직접적으로 증명할 방법이 없다.
 *
 * 로컬에는 Postgres 가 없다(CI 전용). DB 가 없으면 스위트 전체를 skip 한다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q, tx } from "../src/lib/db";
import { enqueue } from "../src/lib/outbox";
import { migrate } from "../src/migrate";
import * as profile from "../src/modules/profile";
import { relayOutbox } from "../src/worker";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

const POLICY = "privacy-vitest";

describe.skipIf(!DB)("플랫폼 outbox (통합 · Postgres 필요)", () => {
  const createdUsers: string[] = [];
  const consentRefs: string[] = [];
  /** 내가 만든 이벤트만 지우기 위한 추적. outbox_events 는 users CASCADE 에 걸리지 않는다. */
  const correlationIds: string[] = [];
  const eventIds: string[] = [];

  beforeAll(async () => {
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    if (consentRefs.length) await q(`DELETE FROM consent_records WHERE subject_ref = ANY($1::text[])`, [consentRefs]);
    if (correlationIds.length)
      await q(`DELETE FROM outbox_events WHERE correlation_id = ANY($1::text[])`, [correlationIds]);
    if (eventIds.length) await q(`DELETE FROM outbox_events WHERE id = ANY($1::uuid[])`, [eventIds]);
    await closePool();
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────────
  // 픽스처
  // ───────────────────────────────────────────────────────────────────────────

  function ctxFor(userId: string | null): Ctx {
    // sessionId 는 Ctx 의 필수 필드다.
    return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: trackCorrelation(randomUUID()) };
  }

  function trackCorrelation(id: string): string {
    correlationIds.push(id);
    return id;
  }

  function trackEvent(id: string): string {
    eventIds.push(id);
    return id;
  }

  /** slug 에 숫자를 두지 않는다 — 이벤트 payload 로 흘러가고 redact() 가 숫자열을 전화번호로 볼 수 있다. */
  function uniqueSlug(): string {
    return `t-${randomUUID().replace(/[0-9]/g, "q")}`;
  }

  async function makeUser(): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO users (id, email, auth_provider, status, platform_role)
       VALUES ($1,$2,'email','active','none')`,
      [id, `test-${id}@example.test`],
    );
    createdUsers.push(id);
    return id;
  }

  /** @param published false 면 미발행 — `profile.publish()` 가 처음 발행하는 경로를 그대로 타게 한다. */
  async function makeProfile(userId: string, published: boolean): Promise<{ id: string; slug: string }> {
    const id = randomUUID();
    const slug = uniqueSlug();
    await q(
      `INSERT INTO profiles (id, user_id, slug, display_name, published_at)
       VALUES ($1,$2,$3,'테스트 담당자', CASE WHEN $4::boolean THEN now() ELSE NULL END)`,
      [id, userId, slug, published],
    );
    return { id, slug };
  }

  /**
   * 리드 행만 직접 만든다.
   *
   * 왜 `lead.createLead()` 를 쓰지 않는가: 그 경로는 접수 시점에 담당자 알림을 **이미** 넣는다(P-107).
   * 그러면 워커가 알림을 새로 넣었는지 중복을 건너뛰었는지 구분할 수 없어 P-184 를 관찰할 수 없다.
   * 암호문 자리에는 자리표시자를 넣는다 — 이 테스트의 소비자 경로는 연락처를 복호화하지 않는다.
   */
  async function makeLeadRow(profileId: string): Promise<string> {
    const leadId = randomUUID();
    const consentId = randomUUID();
    const ref = `lead:${leadId}`;
    consentRefs.push(ref);
    await q(
      `INSERT INTO consent_records (id, subject_ref, purpose, granted, policy_version)
       VALUES ($1,$2,'service',true,$3)`,
      [consentId, ref, POLICY],
    );
    await q(
      `INSERT INTO leads (id, profile_id, contact_name, contact_channel_encrypted, contact_channel_kind,
                          contact_masked, consent_record_id, retention_until)
       VALUES ($1,$2,'박고객','v1:placeholder:not:areal','email','pa***@example.test',$3, now() + interval '180 days')`,
      [leadId, profileId, consentId],
    );
    return leadId;
  }

  async function pendingRows(correlationId: string): Promise<{ id: string; processed_at: Date | null }[]> {
    return q<{ id: string; processed_at: Date | null }>(
      `SELECT id::text AS id, processed_at FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe("P-183: 도메인 쓰기와 이벤트는 같은 트랜잭션이다", () => {
    it(
      "롤백되면 이벤트도 도메인 쓰기도 남지 않는다",
      { timeout: 20_000 },
      async () => {
        const userId = await makeUser();
        const correlationId = trackCorrelation(randomUUID());
        const marker = `/vitest/${randomUUID()}`;

        await expect(
          tx(async (c) => {
            // 도메인 쓰기 (알림은 리드 접수가 실제로 같은 트랜잭션에서 하는 쓰기다).
            await c.query(
              `INSERT INTO notifications (user_id, kind, title, body, link)
               VALUES ($1,'lead.created','테스트','본문 없음',$2)`,
              [userId, marker],
            );
            await enqueue(c, {
              eventType: "lead.created",
              aggregateType: "lead",
              correlationId,
              payload: { phase: "rollback" },
            });
            // 커밋 직전에 터뜨린다 — 발행 경로가 같은 트랜잭션에 묶여 있는지 보는 유일한 방법이다.
            throw new Error("의도된 롤백");
          }),
        ).rejects.toThrow("의도된 롤백");

        expect(await pendingRows(correlationId)).toHaveLength(0);
        const notes = await q<{ id: string }>(`SELECT id::text AS id FROM notifications WHERE link = $1`, [marker]);
        expect(notes).toHaveLength(0);
      },
    );

    it(
      "커밋되면 이벤트와 도메인 쓰기가 함께 남고, 이벤트는 미처리 상태로 대기한다",
      { timeout: 20_000 },
      async () => {
        const userId = await makeUser();
        const correlationId = trackCorrelation(randomUUID());
        const marker = `/vitest/${randomUUID()}`;

        const eventId = await tx(async (c) => {
          await c.query(
            `INSERT INTO notifications (user_id, kind, title, body, link)
             VALUES ($1,'lead.created','테스트','본문 없음',$2)`,
            [userId, marker],
          );
          return enqueue(c, {
            eventType: "lead.created",
            aggregateType: "lead",
            correlationId,
            payload: { phase: "commit" },
          });
        });

        const rows = await pendingRows(correlationId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(eventId);
        // 발행은 워커의 몫이다 — 기록 시점에는 미처리여야 한다.
        expect(rows[0]?.processed_at).toBeNull();

        const queued = await one<{ id: string }>(
          // outbox_pending_idx 와 같은 조건 (processed_at IS NULL AND next_attempt_at <= now()).
          `SELECT id::text AS id FROM outbox_events
            WHERE id = $1 AND processed_at IS NULL AND next_attempt_at <= now()`,
          [eventId],
        );
        expect(queued?.id).toBe(eventId);

        const notes = await q<{ id: string }>(`SELECT id::text AS id FROM notifications WHERE link = $1`, [marker]);
        expect(notes).toHaveLength(1);
      },
    );

    it(
      "N-13: payload 에 이메일·전화를 넣어도 원문은 저장되지 않는다",
      { timeout: 20_000 },
      async () => {
        const correlationId = trackCorrelation(randomUUID());
        const email = "hong.gildong@example.test";
        const phone = "010-9876-5432";

        await tx((c) =>
          enqueue(c, {
            eventType: "lead.created",
            aggregateType: "lead",
            correlationId,
            payload: {
              // 키 이름으로 잡히는 경우
              contactEmail: email,
              // 중립적인 키 안에 섞여 들어온 경우
              note: `회신처: ${email} / ${phone}`,
            },
          }),
        );

        const row = await one<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox_events WHERE correlation_id = $1`,
          [correlationId],
        );
        const raw = JSON.stringify(row?.payload ?? {});
        expect(raw).not.toContain(email);
        expect(raw).not.toContain("hong.gildong");
        expect(raw).not.toContain(phone);
        expect(raw).not.toContain("9876");
        // 지웠다는 사실은 남는다 — 디버깅에 필요한 "여기에 무엇이 있었는지"는 보존된다.
        expect(row?.payload.contactEmail).toBe("[redacted]");
        expect(String(row?.payload.note)).toContain("[redacted:email]");
        expect(String(row?.payload.note)).toContain("[redacted:phone]");
      },
    );

    it(
      "모듈 경로: profile.publish 가 profile.published 이벤트를 같은 트랜잭션에 남긴다",
      { timeout: 20_000 },
      async () => {
        const userId = await makeUser();
        const prof = await makeProfile(userId, false);
        const ctx = ctxFor(userId);

        const published = await profile.publish(ctx);
        expect(published.publishedAt).not.toBe("");

        const events = await q<{ event_type: string; aggregate_type: string; aggregate_id: string | null }>(
          `SELECT event_type, aggregate_type, aggregate_id::text AS aggregate_id
             FROM outbox_events WHERE correlation_id = $1`,
          [ctx.requestId],
        );
        expect(events).toHaveLength(1);
        expect(events[0]?.event_type).toBe("profile.published");
        expect(events[0]?.aggregate_type).toBe("profile");
        expect(events[0]?.aggregate_id).toBe(prof.id);

        // 이미 발행된 프로필을 다시 발행해도 이벤트가 쌓이지 않는다 (같은 사건을 두 번 알리지 않는다).
        const again = ctxFor(userId);
        await profile.publish(again);
        expect(await pendingRows(again.requestId)).toHaveLength(0);
      },
    );

    it(
      "카탈로그 밖의 이벤트 이름은 기록되지 않는다",
      { timeout: 20_000 },
      async () => {
        // 타이포로 만들어진 이벤트는 구독자가 없어 조용히 사라진다. 조용한 실패보다 즉시 예외가 낫다.
        await expect(
          tx((c) =>
            enqueue(c, {
              // @ts-expect-error 카탈로그(PROPLUS_EVENTS) 밖의 이름은 타입에서도 거부된다 — 런타임도 막는지 본다.
              eventType: "lead.createdd",
              aggregateType: "lead",
            }),
          ),
        ).rejects.toThrow(/카탈로그/);
      },
    );
  });

  describe("P-184: 중복 소비가 부작용을 두 번 내지 않는다", () => {
    it(
      "같은 이벤트를 두 번 처리해도 알림은 한 건이다",
      { timeout: 20_000 },
      async () => {
        const userId = await makeUser();
        const prof = await makeProfile(userId, true);
        const leadId = await makeLeadRow(prof.id);
        const correlationId = trackCorrelation(randomUUID());

        const eventId = await tx((c) =>
          enqueue(c, {
            eventType: "lead.created",
            aggregateType: "lead",
            aggregateId: leadId,
            correlationId,
            payload: { leadId, profileId: prof.id },
          }),
        );

        const link = `/app/leads/${leadId}`;
        const countNotifications = async (): Promise<number> => {
          const row = await one<{ n: string }>(
            `SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND kind = 'lead.created' AND link = $2`,
            [userId, link],
          );
          return Number(row?.n ?? "0");
        };
        expect(await countNotifications()).toBe(0);

        // 1차 소비
        expect(await relayOutbox()).toBeGreaterThanOrEqual(1);
        expect(await countNotifications()).toBe(1);
        const first = await one<{ processed_at: Date | null }>(
          `SELECT processed_at FROM outbox_events WHERE id = $1`,
          [eventId],
        );
        expect(first?.processed_at).not.toBeNull();

        // 2차 소비: 같은 이벤트를 다시 대기열로 돌린다(= at-least-once 재시도).
        // 부작용이 두 번 생기면 담당자는 같은 상담 알림을 두 번 받는다.
        await q(`UPDATE outbox_events SET processed_at = NULL, next_attempt_at = now() WHERE id = $1`, [eventId]);
        await relayOutbox();
        expect(await countNotifications()).toBe(1);

        const second = await one<{ processed_at: Date | null; attempts: number }>(
          `SELECT processed_at, attempts FROM outbox_events WHERE id = $1`,
          [eventId],
        );
        expect(second?.processed_at).not.toBeNull();
        // 재처리가 실패로 기록되지도 않아야 한다 — "이미 있어서 건너뜀"은 성공이다.
        expect(second?.attempts).toBe(0);
      },
    );

    it(
      "처리 완료·백오프 대기 중인 이벤트는 대기열에 보이지 않는다",
      { timeout: 20_000 },
      async () => {
        const processed = trackEvent(randomUUID());
        const backoff = trackEvent(randomUUID());

        // 소비자가 없는 이벤트 종류를 쓴다 — 집히더라도 다른 테이블에 부작용을 내지 않는다.
        await q(
          `INSERT INTO outbox_events (id, event_type, aggregate_type, processed_at)
           VALUES ($1,'product.updated','product', now())`,
          [processed],
        );
        await q(
          `INSERT INTO outbox_events (id, event_type, aggregate_type, next_attempt_at)
           VALUES ($1,'product.updated','product', now() + interval '1 hour')`,
          [backoff],
        );

        // outbox_pending_idx 의 조건과 같은 쿼리 — 둘 다 걸리지 않아야 한다.
        const queue = await q<{ id: string }>(
          `SELECT id::text AS id FROM outbox_events
            WHERE processed_at IS NULL AND next_attempt_at <= now() AND id = ANY($1::uuid[])`,
          [[processed, backoff]],
        );
        expect(queue).toHaveLength(0);

        await relayOutbox();

        const rows = await q<{ id: string; processed_at: Date | null }>(
          `SELECT id::text AS id, processed_at FROM outbox_events WHERE id = ANY($1::uuid[])`,
          [[processed, backoff]],
        );
        // 백오프가 남은 이벤트는 워커가 집지 않는다. 집어 버리면 지수 백오프가 의미가 없다.
        expect(rows.find((r) => r.id === backoff)?.processed_at).toBeNull();
      },
    );

    it(
      "같은 eventId 로 두 번 기록해도 이벤트는 하나다 (생산자 쪽 멱등)",
      { timeout: 20_000 },
      async () => {
        const correlationId = trackCorrelation(randomUUID());
        const eventId = trackEvent(randomUUID());

        const first = await tx((c) =>
          enqueue(c, { eventType: "report.created", aggregateType: "report", correlationId, eventId }),
        );
        const second = await tx((c) =>
          enqueue(c, { eventType: "report.created", aggregateType: "report", correlationId, eventId }),
        );
        expect(first).toBe(eventId);
        expect(second).toBe(eventId);

        // ON CONFLICT (id) DO NOTHING — 재시도가 같은 사건을 두 번 발행하지 않게 한다 (P-184 생산자 쪽).
        expect(await pendingRows(correlationId)).toHaveLength(1);
      },
    );
  });
});
