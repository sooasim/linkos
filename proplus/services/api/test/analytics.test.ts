/**
 * M09 Analytics 통합테스트 — P-130/N-13 (PII 원문 금지) · P-132/P-133 퍼널 · P-135 기간별 요약.
 *
 * 왜 실제 DB 가 필요한가:
 *   N-13 의 약속은 "해시 함수를 올바르게 썼다"가 아니라 **"저장된 행에 원문이 없다"** 다.
 *   그건 테이블에 실제로 들어간 값을 읽어야만 확인된다. 그래서 이 파일은 `track()` 을 부른 뒤
 *   `analytics_events` 행을 `to_jsonb(e)` 로 통째로 꺼내 IP·UA·referrer 경로·쿼리가 어디에도
 *   없는지 본다 — 컬럼을 하나씩 확인하면 나중에 추가된 컬럼을 놓치기 때문이다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 스위트 전체를 skip 한다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as analytics from "../src/modules/analytics";
import * as profile from "../src/modules/profile";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

/** 방문자 해시는 salt 가 있을 때만 저장된다 (N-13: 소금 없는 IP 해시는 전수대입으로 복원된다). */
const SALT = process.env.ANALYTICS_SALT ?? process.env.AUTH_SECRET;

const createdUsers: string[] = [];

function ctxFor(userId: string | null): Ctx {
  // `sessionId` 는 Ctx 의 필수 필드다 (P-003). 테스트 문맥에는 세션 행이 없다.
  return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO users (id, email, auth_provider, status) VALUES ($1,$2,'email','active')`, [
    id,
    `test-${id}@example.test`,
  ]);
  createdUsers.push(id);
  return id;
}

interface Owner {
  ctx: Ctx;
  profileId: string;
  slug: string;
}

async function newPublishedProfile(): Promise<Owner> {
  const ctx = ctxFor(await newUser());
  const created = await profile.createProfile(ctx, {
    slug: `an-${randomUUID().slice(0, 18)}`,
    displayName: "통계 테스트",
  });
  await profile.publish(ctx);
  return { ctx, profileId: created.id, slug: created.slug };
}

/** 이 프로필의 이벤트만 읽는다 — 같은 DB 에서 다른 테스트가 심은 행과 섞이지 않게. */
async function eventsOf(profileId: string): Promise<Record<string, unknown>[]> {
  const rows = await q<{ doc: Record<string, unknown> }>(
    `SELECT to_jsonb(e) AS doc FROM analytics_events e WHERE e.profile_id = $1 ORDER BY e.id`,
    [profileId],
  );
  return rows.map((r) => r.doc);
}

async function rejectedWith(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; status?: number },
  );
  expect(err, `거부되지 않았다 (기대 code=${code})`).not.toBeNull();
  expect(err?.code).toBe(code);
  if (status !== undefined) expect(err?.status).toBe(status);
}

describe.skipIf(!DB)("M09 Analytics 통합 (실제 Postgres)", () => {
  beforeAll(async () => {
    await migrate();
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length > 0) {
      // analytics_events 는 profiles CASCADE, profiles 는 users CASCADE 로 함께 사라진다.
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    await closePool();
  }, 60_000);

  describe("P-130 / N-13: 저장된 이벤트에 IP·UA 원문이 없다", () => {
    it(
      "track 이 남긴 행에 IP·UA·referrer 경로·쿼리가 어디에도 없다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const ip = "198.51.100.37";
        const userAgent = `Mozilla/5.0 vitest-ua-${randomUUID()}`;
        const secret = `token-${randomUUID()}`;

        const out = await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip,
          userAgent,
          referrer: `https://mail.example.test/inbox/thread-42?q=${secret}`,
          utm: { utm_source: "newsletter", utm_term: "의료기기", not_an_utm_key: "버려져야 한다" },
        });
        expect(out.recorded).toBe(true);

        const rows = await eventsOf(owner.profileId);
        expect(rows).toHaveLength(1);
        const text = JSON.stringify(rows[0]);

        expect(text, "IP 원문이 저장됐다").not.toContain(ip);
        expect(text, "UA 원문이 저장됐다").not.toContain(userAgent);
        expect(text, "referrer 쿼리문자열이 저장됐다").not.toContain(secret);
        expect(text, "referrer 경로가 저장됐다").not.toContain("/inbox/thread-42");

        // 유입 분석에 필요한 것은 "어디서 왔나"뿐이다 → 호스트만 남는다.
        expect(rows[0]?.referrer_host).toBe("mail.example.test");
        // P-134: 허용된 UTM 키만 남는다. 나머지 쿼리 파라미터는 PII 유입 통로이므로 버린다.
        expect(rows[0]?.utm).toEqual({ utm_source: "newsletter", utm_term: "의료기기" });

        // 스키마 차원의 확인: 원문을 담을 **컬럼 자체가** 없다.
        const cols = (
          await q<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_events'`,
          )
        ).map((c) => c.column_name);
        for (const forbidden of ["ip", "ip_address", "user_agent", "ua", "referrer", "email", "phone"]) {
          expect(cols, `analytics_events 에 ${forbidden} 컬럼이 생겼다`).not.toContain(forbidden);
        }
      },
    );

    it(
      "닫힌 집합 밖의 kind 는 거부된다 (자유 문자열로 PII 가 들어오는 통로를 막는다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        await rejectedWith(
          analytics.track({
            kind: "lead:hong@example.test",
            slug: owner.slug,
            ip: "198.51.100.38",
            userAgent: "vitest",
          }),
          "unknown_kind",
          400,
        );
        expect(await eventsOf(owner.profileId)).toHaveLength(0);
      },
    );

    it.skipIf(!SALT)(
      "visitor_hash 는 해시 모양이고, 같은 (ip,ua) 는 같은 값 · 다른 입력은 다른 값이다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const userAgent = `vitest-ua-${randomUUID()}`;

        await analytics.track({ kind: "profile_view", slug: owner.slug, ip: "198.51.100.40", userAgent });
        await analytics.track({ kind: "profile_view", slug: owner.slug, ip: "198.51.100.40", userAgent });
        await analytics.track({ kind: "profile_view", slug: owner.slug, ip: "198.51.100.41", userAgent });
        await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip: "198.51.100.40",
          userAgent: `${userAgent}-other`,
        });

        const hashes = (
          await q<{ visitor_hash: string | null }>(
            `SELECT visitor_hash FROM analytics_events WHERE profile_id = $1 ORDER BY id`,
            [owner.profileId],
          )
        ).map((r) => r.visitor_hash);
        expect(hashes).toHaveLength(4);

        const [h1, h2, h3, h4] = hashes;
        expect(h1).toMatch(/^[0-9a-f]{32}$/);
        // 같은 방문자는 같은 버킷으로 세야 "고유 방문자" 수치가 의미를 가진다.
        expect(h2).toBe(h1);
        // IP 가 바뀌면 다른 값 (해시가 입력을 실제로 반영한다)
        expect(h3).not.toBe(h1);
        // UA 가 바뀌면 다른 값
        expect(h4).not.toBe(h1);
      },
    );

    it(
      "salt 가 없으면 해시를 저장하지 않는다 (null) — 소금 없는 IP 해시는 원문과 다르지 않다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const savedAnalyticsSalt = process.env.ANALYTICS_SALT;
        const savedAuthSecret = process.env.AUTH_SECRET;
        try {
          delete process.env.ANALYTICS_SALT;
          delete process.env.AUTH_SECRET;
          await analytics.track({
            kind: "profile_view",
            slug: owner.slug,
            ip: "198.51.100.50",
            userAgent: "vitest-no-salt",
          });
        } finally {
          // 같은 프로세스의 다른 테스트가 salt 를 기대한다. 반드시 되돌린다.
          if (savedAnalyticsSalt !== undefined) process.env.ANALYTICS_SALT = savedAnalyticsSalt;
          if (savedAuthSecret !== undefined) process.env.AUTH_SECRET = savedAuthSecret;
        }

        const rows = await eventsOf(owner.profileId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.visitor_hash).toBeNull();
        expect(JSON.stringify(rows[0])).not.toContain("198.51.100.50");
      },
    );

    it(
      "비공개·미발행 프로필의 사건은 기록되지 않는다 (N-4: 공개 뷰로만 해석한다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        await profile.unpublish(owner.ctx);
        const out = await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip: "198.51.100.60",
          userAgent: "vitest",
        });
        expect(out.recorded).toBe(false);
        expect(await eventsOf(owner.profileId)).toHaveLength(0);
      },
    );
  });

  describe("P-135: 집계는 기준과 기간을 수치와 함께 돌려준다", () => {
    it(
      "summary 응답에 period(from/to)와 basis 가 있다 — 수치만 돌려주면 실패다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip: "198.51.100.70",
          userAgent: "vitest-summary",
        });

        const from = new Date(Date.now() - 3_600_000);
        const to = new Date(Date.now() + 3_600_000);
        const res = await analytics.summary(owner.ctx, from, to);

        // M09 수용기준: "집계 기준·기간을 응답에 명시한다".
        expect(Object.keys(res).sort()).toEqual(["basis", "metrics", "period"]);
        expect(typeof res.period.from).toBe("string");
        expect(typeof res.period.to).toBe("string");
        expect(Number.isNaN(Date.parse(res.period.from))).toBe(false);
        expect(Number.isNaN(Date.parse(res.period.to))).toBe(false);
        expect(Date.parse(res.period.from)).toBeLessThan(Date.parse(res.period.to));
        expect(typeof res.basis).toBe("string");
        expect(res.basis.length).toBeGreaterThan(0);
        expect(res.metrics.views).toBe(1);

        // 퍼널도 같은 규칙이다 — 분모가 무엇인지 모르면 전환율은 읽을 수 없다.
        const funnel = await analytics.conversionFunnel(owner.ctx, from, to);
        expect(Object.keys(funnel).sort()).toEqual(["basis", "period", "stages"]);
        expect(funnel.basis.length).toBeGreaterThan(0);
        expect(funnel.period.from).toBe(res.period.from);
      },
    );

    it(
      "통계는 자기 프로필의 것만 본다 (다른 사용자의 ctx 로는 볼 수 없다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const stranger = ctxFor(await newUser());
        const from = new Date(Date.now() - 3_600_000);
        const to = new Date(Date.now() + 3_600_000);

        // 남의 프로필 통계를 보는 인자 자체가 없다 — 프로필이 없으면 404 로 끝난다.
        await rejectedWith(analytics.summary(stranger, from, to), "not_found", 404);
        // 기간이 거꾸로면 집계하지 않는다.
        await rejectedWith(analytics.summary(owner.ctx, to, from), "invalid_period", 400);
      },
    );
  });

  describe("P-132 / P-133: 조회 → CTA → 상담 → 예약 퍼널", () => {
    it(
      "단계별 건수와 전환율이 기준대로 집계된다",
      { timeout: 30_000 },
      async () => {
        const owner = await newPublishedProfile();
        const now = Date.now();
        const at = (minutesAgo: number): Date => new Date(now - minutesAgo * 60_000);

        // 서로 다른 방문자 3명의 조회
        for (const [i, visitor] of ["198.51.100.81", "198.51.100.82", "198.51.100.83"].entries()) {
          await analytics.track({
            kind: "profile_view",
            slug: owner.slug,
            ip: visitor,
            userAgent: "vitest-funnel",
            occurredAt: at(30 - i),
          });
        }
        // 그중 둘이 CTA 를 누르고, 하나가 상담을 남기고, 하나가 예약까지 갔다.
        for (const visitor of ["198.51.100.81", "198.51.100.82"]) {
          await analytics.track({
            kind: "cta_click",
            slug: owner.slug,
            ip: visitor,
            userAgent: "vitest-funnel",
            target: "contact",
            occurredAt: at(20),
          });
        }
        await analytics.track({
          kind: "lead_submit",
          slug: owner.slug,
          ip: "198.51.100.81",
          userAgent: "vitest-funnel",
          occurredAt: at(10),
        });
        await analytics.track({
          kind: "appointment_booked",
          slug: owner.slug,
          ip: "198.51.100.81",
          userAgent: "vitest-funnel",
          occurredAt: at(5),
        });

        const funnel = await analytics.conversionFunnel(owner.ctx, at(60), new Date(now + 60_000));
        const byStage = new Map(funnel.stages.map((s) => [s.stage, s]));

        expect(funnel.stages.map((s) => s.stage)).toEqual([
          "profile_view",
          "cta_click",
          "lead_submit",
          "appointment_booked",
        ]);
        expect(byStage.get("profile_view")?.count).toBe(3);
        expect(byStage.get("cta_click")?.count).toBe(2);
        expect(byStage.get("lead_submit")?.count).toBe(1);
        expect(byStage.get("appointment_booked")?.count).toBe(1);

        // 첫 단계에는 "직전"이 없다 — 0 이 아니라 null 이어야 한다("0%"와 "분모 없음"은 다른 사실이다).
        expect(byStage.get("profile_view")?.fromPrevious).toBeNull();
        expect(byStage.get("profile_view")?.fromTop).toBeNull();
        expect(byStage.get("cta_click")?.fromPrevious).toBeCloseTo(2 / 3, 4);
        expect(byStage.get("lead_submit")?.fromPrevious).toBeCloseTo(1 / 2, 4);
        expect(byStage.get("lead_submit")?.fromTop).toBeCloseTo(1 / 3, 4);
        expect(byStage.get("appointment_booked")?.fromPrevious).toBe(1);

        // 같은 기간의 summary 가 같은 수치를 말한다 (두 응답이 다른 세계의 숫자이면 안 된다).
        const sum = await analytics.summary(owner.ctx, at(60), new Date(now + 60_000));
        expect(sum.metrics.views).toBe(3);
        expect(sum.metrics.uniqueVisitors).toBe(SALT ? 3 : 0);
        expect(sum.metrics.ctaClicks).toBe(2);
        expect(sum.metrics.leadSubmits).toBe(1);
        expect(sum.metrics.appointmentsBooked).toBe(1);
      },
    );

    it(
      "표본이 없으면 전환율은 0 이 아니라 null 이다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const funnel = await analytics.conversionFunnel(
          owner.ctx,
          new Date(Date.now() - 3_600_000),
          new Date(Date.now() + 3_600_000),
        );
        for (const stage of funnel.stages) {
          expect(stage.count).toBe(0);
          expect(stage.fromPrevious).toBeNull();
          expect(stage.fromTop).toBeNull();
        }
      },
    );
  });

  describe("P-135: 기간 밖 이벤트는 집계에서 빠진다", () => {
    it(
      "from 은 포함하고 to 는 제외한다. 기간 밖 이벤트는 세지 않는다",
      { timeout: 30_000 },
      async () => {
        const owner = await newPublishedProfile();
        const t = new Date(Date.now() - 2 * 3_600_000);

        await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip: "198.51.100.91",
          userAgent: "vitest-period",
          occurredAt: t,
        });
        // 10일 전 이벤트 — 짧은 기간 조회에서는 빠져야 한다.
        await analytics.track({
          kind: "profile_view",
          slug: owner.slug,
          ip: "198.51.100.92",
          userAgent: "vitest-period",
          occurredAt: new Date(Date.now() - 10 * 86_400_000),
        });

        // 경계: occurred_at >= from 이고 occurred_at < to 다.
        const included = await analytics.summary(owner.ctx, t, new Date(t.getTime() + 60_000));
        expect(included.metrics.views).toBe(1);
        const excluded = await analytics.summary(owner.ctx, new Date(t.getTime() - 60_000), t);
        expect(excluded.metrics.views).toBe(0);

        // 하루 창에는 10일 전 이벤트가 들어오지 않는다.
        const oneDay = await analytics.summary(
          owner.ctx,
          new Date(Date.now() - 86_400_000),
          new Date(Date.now() + 60_000),
        );
        expect(oneDay.metrics.views).toBe(1);

        // P-141: 요금제 보관 기간보다 과거를 요청하면 **잘렸다는 사실이 응답에 남는다**.
        // 조용히 자르면 사용자는 "데이터가 없다"와 "요금제가 가린다"를 구분할 수 없다.
        const clamped = await analytics.summary(
          owner.ctx,
          new Date(Date.now() - 400 * 86_400_000),
          new Date(Date.now() + 60_000),
        );
        expect(clamped.period.clampedByPlan).toBe(true);
        expect(clamped.period.planCode).toBe("free");
        expect(clamped.period.retentionDays).toBeGreaterThan(0);
        expect(Date.parse(clamped.period.from)).toBeGreaterThan(Date.parse(clamped.period.requestedFrom));
        // 보관 기간(30일) 안의 두 건만 보인다.
        expect(clamped.metrics.views).toBe(2);
      },
    );

    it(
      "일별 집계는 UTC 경계를 쓴다 (basis 가 말하는 기준과 같다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        // UTC 로 어제 23:30 과 오늘 00:30 — 지역 시간대 기준이면 같은 날로 묶일 수 있는 두 시각이다.
        const todayUtc = new Date();
        const midnight = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
        const beforeMidnight = new Date(midnight - 30 * 60_000);
        const afterMidnight = new Date(midnight + 30 * 60_000);

        for (const occurredAt of [beforeMidnight, afterMidnight]) {
          await analytics.track({
            kind: "profile_view",
            slug: owner.slug,
            ip: "198.51.100.95",
            userAgent: "vitest-byday",
            occurredAt,
          });
        }

        const res = await analytics.summary(
          owner.ctx,
          new Date(midnight - 86_400_000),
          new Date(midnight + 86_400_000),
        );
        const days = res.metrics.byDay.filter((d) => d.kind === "profile_view").map((d) => d.day);
        expect(days).toHaveLength(2);
        expect(days[0]).not.toBe(days[1]);
        expect(days[1]).toBe(new Date(midnight).toISOString().slice(0, 10));
      },
    );
  });
});
