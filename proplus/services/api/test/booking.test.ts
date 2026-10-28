/**
 * M08 Booking 통합테스트 — P-122 이중 예약 방지 · P-195 UTC 저장 (전략 §9 통합 층).
 *
 * 이 파일의 주제는 하나다: **이중 예약을 막는 것은 애플리케이션이 아니라 DB 다.**
 *
 * `modules/booking.ts` 에도 겹침 사전 검사가 있지만, 그것은 사용자에게 친절한 메시지를 주기 위한
 * 것이고 동시 요청을 막지 못한다 — 두 요청이 같은 순간에 "비어 있다"를 확인한 뒤 둘 다 INSERT 하는
 * 창이 항상 있다. 실제 방어선은 `appointments_no_overlap`(EXCLUDE USING gist)이다. 그래서 여기서는
 * **모듈을 우회해 직접 INSERT** 해서 제약이 정말 거부하는지 확인한다. 사전 검사를 지워도 이중 예약이
 * 생기지 않아야 하고, 제약을 지우면 생겨야 한다 — 그 사실을 고정하는 것이 이 테스트다.
 *
 * 로컬에는 Postgres 가 없다(CI 에만 있다). DB 가 없으면 스위트 전체를 skip 한다 —
 * 로컬 테스트가 빨간색이면 아무도 돌리지 않게 되고, 그게 테스트가 없는 것보다 나쁘다.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../src/lib/ctx";
import { closePool, one, q } from "../src/lib/db";
import { migrate } from "../src/migrate";
import * as booking from "../src/modules/booking";
import * as profile from "../src/modules/profile";

const DB = process.env.PROPLUS_DATABASE_URL ?? process.env.DATABASE_URL;

const createdUsers: string[] = [];

/** 예약 행의 `cancellation_policy_version` 은 NOT NULL 이다. 값은 마이그레이션 시드에서 읽는다. */
let cancellationPolicy = "";

function ctxFor(userId: string | null): Ctx {
  // `sessionId` 는 Ctx 의 필수 필드다 (P-003). 테스트 문맥에는 세션 행이 없으므로 null 이다.
  return { userId, sessionId: null, ip: "127.0.0.1", userAgent: "vitest", requestId: randomUUID() };
}

/**
 * 비회원 방문자 문맥. `ip` 를 매번 다르게 만드는 이유는 rate limit 버킷(`lead.create`, 10분 5건)을
 * 테스트끼리 공유하지 않기 위함이다 — 한도를 끄면 "한도가 사라진 것"을 테스트가 못 보게 된다.
 */
function guestCtx(): Ctx {
  return {
    userId: null,
    sessionId: null,
    ip: `visitor-${randomUUID()}`,
    userAgent: "vitest-guest",
    requestId: randomUUID(),
  };
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
    slug: `bk-${randomUUID().slice(0, 18)}`,
    displayName: "예약 테스트",
  });
  await profile.publish(ctx);
  return { ctx, profileId: created.id, slug: created.slug };
}

/**
 * 슬롯 격자를 가진 프로필.
 *
 * 규칙을 **Asia/Seoul 10:00~12:00 / 30분**으로 두고, 테스트는 그에 대응하는 UTC 시각(01:00Z~)을 쓴다.
 * 이렇게 짜면 "요청은 UTC, 규칙은 지역 시각, 저장은 UTC" 라는 P-195 의 구조가 테스트 안에서 드러난다.
 */
async function ownerWithAvailability(): Promise<Owner> {
  const owner = await newPublishedProfile();
  await booking.setAvailability(owner.ctx, [
    { weekday: slotAt(1).getUTCDay(), startMin: 600, endMin: 720, timezone: "Asia/Seoul", slotMinutes: 30 },
  ]);
  return owner;
}

/**
 * 이 파일이 쓰는 기준 날짜(14일 뒤). **모듈 로드 시 한 번** 정한다 — 매 호출마다 `Date.now()` 로
 * 계산하면 테스트가 UTC 자정을 걸쳐 돌 때 날짜가 하루 밀려 가용 규칙의 요일과 어긋난다.
 */
const BASE_DAY = new Date(Date.now() + 14 * 86_400_000);

/**
 * 기준 날짜의 UTC 시각. 과거 시각은 `requestAppointment` 가 거부하므로 기본값은 미래다.
 * 01:00Z = Asia/Seoul 10:00 (한국은 DST 가 없어 지역 날짜가 흔들리지 않는다).
 */
function slotAt(hourUtc: number, minuteUtc = 0, dayOffset = 0): Date {
  return new Date(
    Date.UTC(
      BASE_DAY.getUTCFullYear(),
      BASE_DAY.getUTCMonth(),
      BASE_DAY.getUTCDate() + dayOffset,
      hourUtc,
      minuteUtc,
      0,
      0,
    ),
  );
}

function plusMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** 모듈을 우회한 직접 INSERT. 제약이 **애플리케이션 없이도** 막는지 보려면 이 경로가 필요하다. */
function rawInsert(profileId: string, start: Date, end: Date, status = "requested"): Promise<unknown> {
  return q(
    `INSERT INTO appointments (profile_id, start_at, end_at, timezone, status, cancellation_policy_version)
     VALUES ($1,$2,$3,'Asia/Seoul',$4,$5)`,
    [profileId, start.toISOString(), end.toISOString(), status, cancellationPolicy],
  );
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

describe.skipIf(!DB)("M08 Booking 통합 (실제 Postgres)", () => {
  beforeAll(async () => {
    await migrate();
    const row = await one<{ version: string }>(
      `SELECT version FROM policy_versions
        WHERE kind = 'cancellation' AND effective_at <= now()
        ORDER BY effective_at DESC LIMIT 1`,
    );
    // P-123: 취소 정책 없이는 예약을 받지 않는다. 정책 행이 없으면 아래 테스트의 전제가 무너지므로 먼저 확인한다.
    expect(row?.version, "cancellation 정책 버전이 시드되지 않았다").toBeTruthy();
    cancellationPolicy = row?.version ?? "";
  }, 60_000);

  afterAll(async () => {
    if (createdUsers.length > 0) {
      // appointments·availability_rules 는 profiles CASCADE 로, profiles 는 users CASCADE 로 사라진다.
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    await closePool();
  }, 60_000);

  describe("P-122: 겹치는 예약은 DB 배타 제약이 거부한다", () => {
    it(
      "같은 프로필·겹치는 시간을 두 번 INSERT 하면 두 번째가 거부된다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const start = slotAt(1);

        await rawInsert(owner.profileId, start, plusMinutes(start, 30));

        // 부분 겹침 (뒤쪽이 앞 예약 안으로 들어온다)
        await expect(
          rawInsert(owner.profileId, plusMinutes(start, 15), plusMinutes(start, 45)),
        ).rejects.toThrow(/appointments_no_overlap/);

        // 완전히 같은 구간
        await expect(rawInsert(owner.profileId, start, plusMinutes(start, 30))).rejects.toThrow(
          /appointments_no_overlap/,
        );

        // 앞 예약을 감싸는 더 긴 구간
        await expect(
          rawInsert(owner.profileId, plusMinutes(start, -30), plusMinutes(start, 60)),
        ).rejects.toThrow(/appointments_no_overlap/);

        // 상태가 달라도(requested ↔ confirmed) 둘 다 제약의 WHERE 안이므로 막힌다.
        await expect(
          rawInsert(owner.profileId, plusMinutes(start, 10), plusMinutes(start, 20), "confirmed"),
        ).rejects.toThrow(/appointments_no_overlap/);

        // 거부가 행을 남기지 않았다 — 처음 한 건뿐이다.
        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM appointments WHERE profile_id = $1`,
          [owner.profileId],
        );
        expect(rows[0]?.n).toBe(1);
      },
    );

    it(
      "취소된 예약과는 겹쳐도 된다 (제약의 WHERE 절이 requested·confirmed 만 본다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const start = slotAt(1);

        // 취소 예약을 먼저 넣고 같은 시간에 새 예약 — 취소된 시간은 다시 팔 수 있어야 한다.
        await rawInsert(owner.profileId, start, plusMinutes(start, 30), "canceled");
        await rawInsert(owner.profileId, start, plusMinutes(start, 30), "requested");

        // 반대 순서도 성립한다: 활성 예약 위에 취소 이력을 겹쳐 넣을 수 있다.
        await rawInsert(owner.profileId, plusMinutes(start, 10), plusMinutes(start, 20), "canceled");

        // 완료·노쇼도 제약 밖이다(지난 약속이 다음 예약을 막지 않는다).
        await rawInsert(owner.profileId, start, plusMinutes(start, 30), "completed");
        await rawInsert(owner.profileId, start, plusMinutes(start, 30), "no_show");

        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM appointments WHERE profile_id = $1`,
          [owner.profileId],
        );
        expect(rows[0]?.n).toBe(5);
      },
    );

    it(
      "다른 프로필끼리는 같은 시간에 겹쳐도 된다 (제약이 profile_id 로 분리된다)",
      { timeout: 20_000 },
      async () => {
        const a = await newPublishedProfile();
        const b = await newPublishedProfile();
        const start = slotAt(1);

        await rawInsert(a.profileId, start, plusMinutes(start, 30));
        await rawInsert(b.profileId, start, plusMinutes(start, 30));

        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM appointments WHERE profile_id = ANY($1::uuid[])`,
          [[a.profileId, b.profileId]],
        );
        expect(rows[0]?.n).toBe(2);
      },
    );

    it(
      "맞닿은 구간은 겹침이 아니다 (tstzrange 는 끝이 열린 `[)` 구간이다)",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const start = slotAt(1);

        await rawInsert(owner.profileId, start, plusMinutes(start, 30));
        // 앞 예약의 end == 뒤 예약의 start → 연속 예약은 허용돼야 한다. 막으면 하루가 반쯤 빈다.
        await rawInsert(owner.profileId, plusMinutes(start, 30), plusMinutes(start, 60));
        // 뒤 예약의 end == 앞 예약의 start (앞쪽에 붙이기)
        await rawInsert(owner.profileId, plusMinutes(start, -30), start);

        // 1초라도 물리면 거부된다 — 경계가 "닫힘"이 아니라 "열림"이라는 뜻이다.
        await expect(
          rawInsert(owner.profileId, plusMinutes(start, 29), plusMinutes(start, 59)),
        ).rejects.toThrow(/appointments_no_overlap/);

        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM appointments WHERE profile_id = $1`,
          [owner.profileId],
        );
        expect(rows[0]?.n).toBe(3);
      },
    );

    it(
      "end_at 이 start_at 보다 앞이거나 같으면 CHECK 가 거부한다",
      { timeout: 20_000 },
      async () => {
        const owner = await newPublishedProfile();
        const start = slotAt(1);

        // 거꾸로 된 구간. 통과하면 tstzrange 생성 자체가 실패해 제약이 무력해진다.
        await expect(rawInsert(owner.profileId, start, plusMinutes(start, -30))).rejects.toThrow(
          /check constraint/i,
        );
        // 길이 0 구간
        await expect(rawInsert(owner.profileId, start, start)).rejects.toThrow(/check constraint/i);

        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM appointments WHERE profile_id = $1`,
          [owner.profileId],
        );
        expect(rows[0]?.n).toBe(0);
      },
    );
  });

  describe("P-122: 모듈 경로도 같은 상황에서 conflict 를 돌려준다", () => {
    it(
      "이미 잡힌 슬롯을 다시 요청하면 409 slot_taken, 취소 뒤에는 다시 받는다",
      { timeout: 30_000 },
      async () => {
        const owner = await ownerWithAvailability();
        const slot = slotAt(1);

        const first = await booking.requestAppointment(guestCtx(), owner.slug, { startAt: slot.toISOString() });
        expect(first.status).toBe("requested");
        expect(first.cancellationPolicyVersion).toBe(cancellationPolicy);

        await rejectedWith(
          booking.requestAppointment(guestCtx(), owner.slug, { startAt: slot.toISOString() }),
          "slot_taken",
          409,
        );

        // 격자 밖 시각은 애초에 들어오지 못한다 — "표시된 적 없는 슬롯"으로 예약이 생기지 않게.
        await rejectedWith(
          booking.requestAppointment(guestCtx(), owner.slug, { startAt: plusMinutes(slot, 7).toISOString() }),
          "slot_unavailable",
          400,
        );

        // 옆 슬롯은 비어 있다(맞닿은 구간은 겹침이 아니다).
        const next = await booking.requestAppointment(guestCtx(), owner.slug, {
          startAt: plusMinutes(slot, 30).toISOString(),
        });
        expect(next.startAt).toBe(plusMinutes(slot, 30).toISOString());

        // 취소하면 같은 슬롯을 다시 받는다 — 모듈 사전검사와 DB 제약이 같은 규칙을 쓴다는 증거.
        await booking.cancelAppointment(owner.ctx, first.id);
        const again = await booking.requestAppointment(guestCtx(), owner.slug, { startAt: slot.toISOString() });
        expect(again.id).not.toBe(first.id);
        expect(again.startAt).toBe(first.startAt);
      },
    );
  });

  describe("P-195: 시각은 UTC 로 저장되고 timezone 컬럼은 표시용이다", () => {
    it(
      "넘긴 값과 저장된 값이 같은 순간이고, 다른 오프셋 표기도 같은 값이 된다",
      { timeout: 30_000 },
      async () => {
        // 같은 프로필에 같은 시각을 두 번 넣으면 (당연히) 배타 제약이 막으므로 프로필을 둘 쓴다.
        const a = await ownerWithAvailability();
        const b = await ownerWithAvailability();
        const slot = slotAt(1);
        const localDate = slot.toISOString().slice(0, 10);

        const utcForm = await booking.requestAppointment(guestCtx(), a.slug, { startAt: slot.toISOString() });
        // 같은 순간을 Asia/Seoul 오프셋으로 표기한 것 (01:00Z == 10:00+09:00)
        const offsetForm = await booking.requestAppointment(guestCtx(), b.slug, {
          startAt: `${localDate}T10:00:00+09:00`,
        });

        expect(utcForm.startAt).toBe(slot.toISOString());
        expect(offsetForm.startAt).toBe(utcForm.startAt);

        const row = await one<{ start_at: Date; end_at: Date; timezone: string }>(
          `SELECT start_at, end_at, timezone FROM appointments WHERE id = $1`,
          [utcForm.id],
        );
        expect(row).not.toBeNull();
        expect(row?.start_at.toISOString()).toBe(slot.toISOString());
        // 끝 시각은 규칙의 슬롯 길이에서 나온다(호출자가 고르지 않는다).
        expect((row?.end_at.getTime() ?? 0) - (row?.start_at.getTime() ?? 0)).toBe(30 * 60_000);
        // 시간대는 "무엇으로 보여줄지"일 뿐이고 저장된 순간을 바꾸지 않는다.
        expect(row?.timezone).toBe("Asia/Seoul");

        // 지역 시각 환산은 Postgres 가 한다: 10:00 KST 로 저장된 예약은 UTC 로는 01:00 이다.
        const local = await one<{ local_hour: number; utc_hour: number }>(
          `SELECT EXTRACT(HOUR FROM (start_at AT TIME ZONE timezone))::int AS local_hour,
                  EXTRACT(HOUR FROM (start_at AT TIME ZONE 'UTC'))::int    AS utc_hour
             FROM appointments WHERE id = $1`,
          [utcForm.id],
        );
        expect(local?.local_hour).toBe(10);
        expect(local?.utc_hour).toBe(1);
      },
    );

    it(
      "지난 시각은 예약할 수 없다",
      { timeout: 20_000 },
      async () => {
        const owner = await ownerWithAvailability();
        await rejectedWith(
          booking.requestAppointment(guestCtx(), owner.slug, { startAt: slotAt(1, 0, -28).toISOString() }),
          "slot_in_past",
          400,
        );
      },
    );
  });
});
