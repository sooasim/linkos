/**
 * M08 Booking — P-120 가용 시간 · P-121 예약 요청 · P-122 이중 예약 방지 · P-123 확인·취소 ·
 * P-124 예약 알림 · P-125 ICS(미구현).
 *
 * 출처: 모듈명세 M08("이중 예약 방지, 시간대 명시, 취소 정책 표시")
 *       + ADR-006(Cal.com 실사 전 폴백 = 자체 `availability_rules` + `appointments`).
 *
 * ## P-122 — 이중 예약을 막는 것은 애플리케이션이 아니라 DB 다
 *
 * 이 파일에도 겹침 사전 검사가 있다(사용자에게 빠르고 친절한 메시지를 주려는 것이다). 그러나
 * **애플리케이션 검사만으로는 동시 요청을 막지 못한다.** 두 요청이 같은 밀리초에 "비어 있다"를
 * 확인한 뒤 둘 다 INSERT 하는 창이 항상 존재하기 때문이다. 실제 방어선은
 * `appointments_no_overlap`(EXCLUDE USING gist, 0001_proplus_core.sql)이고, 그 제약이 거부하면
 * Postgres 가 `23P01 exclusion_violation` 을 던진다 — 여기서는 그것을 `conflict('slot_taken')` 으로 바꾼다.
 * 그래서 사전 검사를 지워도 이중 예약은 생기지 않는다. 반대로 제약을 지우면 생긴다.
 *
 * ## 시간
 *
 * 모든 시각은 **UTC(`timestamptz`)로 저장하고**, `timezone` 컬럼은 **표시용**이다 (P-195).
 * 슬롯 생성은 Postgres 의 `AT TIME ZONE` 에 맡긴다 — DST 전환(봄에 사라지는 시각, 가을에 두 번 오는 시각)을
 * 자체 계산으로 맞히려는 시도는 매년 틀린다.
 */

import { can } from "@proplus/domain";
import type { MemberRole, PlatformRole, Principal } from "@proplus/domain";
import type { PoolClient } from "pg";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { enqueue } from "../lib/outbox";

/** DB `appointments.status` CHECK 와 1:1. */
export const APPOINTMENT_STATUSES = ["requested", "confirmed", "canceled", "completed", "no_show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** 겹침 배타 제약이 보는 상태. 취소된 예약은 겹쳐도 된다(0001 의 WHERE 절과 같아야 한다). */
const BLOCKING_STATUSES = ["requested", "confirmed"] as const;

export const MAX_AVAILABILITY_RULES = 50;
/** 공개 슬롯 조회 창. 길게 열어 두면 한 요청이 수만 개 슬롯을 만든다. */
export const MAX_SLOT_RANGE_DAYS = 62;
const MAX_SLOTS = 1000;

export interface AvailabilityRuleInput {
  /** 0=일요일 … 6=토요일. Postgres `EXTRACT(DOW)` 와 같은 기준이다(슬롯 생성이 그 값으로 매칭한다). */
  weekday: number;
  startMin: number;
  endMin: number;
  /** IANA 시간대 이름. 저장은 UTC 이고 이 값은 "무엇으로 보여줄지"다 (P-195). */
  timezone: string;
  slotMinutes?: number;
}

export interface AvailabilityRule extends AvailabilityRuleInput {
  id: string;
  slotMinutes: number;
}

export interface Slot {
  startAt: string;
  endAt: string;
  timezone: string;
}

export interface SlotList {
  period: { from: string; to: string };
  /** P-123: 예약 화면이 취소 정책 버전을 함께 보여줄 수 있어야 한다. */
  cancellationPolicyVersion: string | null;
  slots: Slot[];
}

export interface AppointmentRequestInput {
  /** 슬롯 시작 시각(ISO8601, 오프셋 포함 권장). 가용 규칙의 슬롯 격자에 맞아야 한다. */
  startAt: string | Date;
  /**
   * 상품 CTA → 상담 → 예약으로 이어진 경우의 리드 id (P-094).
   * 소유 증명은 uuid 자체다: 이 값은 리드를 만든 쪽만 알고, 아래에서 **같은 프로필의 리드인지** 확인한다.
   */
  leadId?: string | null;
}

export interface Appointment {
  id: string;
  profileId: string;
  leadId: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  status: AppointmentStatus;
  cancellationPolicyVersion: string;
  canceledAt: string | null;
  createdAt: string;
}

/** 취소를 **요청한 주체**. 권한은 아래 주석대로 항상 프로필 소유자 세션으로 확인한다. */
export type CancelActor = "owner" | "visitor" | "system";

type UserRow = { platform_role: PlatformRole };
type MembershipRow = { organization_id: string; role: MemberRole; status: string };
type ProfileRow = { id: string; user_id: string };
type RuleRow = {
  id: string;
  weekday: number;
  start_min: number;
  end_min: number;
  timezone: string;
  slot_minutes: number;
};
type AppointmentRow = {
  id: string;
  profile_id: string;
  lead_id: string | null;
  start_at: Date;
  end_at: Date;
  timezone: string;
  status: string;
  cancellation_policy_version: string;
  canceled_at: Date | null;
  created_at: Date;
};

async function principalOf(ctx: Ctx): Promise<Principal> {
  if (!ctx.userId) throw unauthorized();
  const u = await one<UserRow>(
    `SELECT platform_role FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [ctx.userId],
  );
  if (!u) throw unauthorized();
  const ms = await q<MembershipRow>(
    `SELECT organization_id::text AS organization_id, role::text AS role, status
       FROM memberships WHERE user_id = $1`,
    [ctx.userId],
  );
  return {
    userId: ctx.userId,
    platformRole: u.platform_role,
    memberships: ms.map((m) => ({ organizationId: m.organization_id, role: m.role, status: m.status })),
  };
}

/**
 * 예약은 개인 프로필의 일정이다. ACL 에 예약 전용 능력이 없어 본인 판정에 `profile.edit` 를 쓴다 —
 * 조직 관리자에게 열면 회사가 직원의 개인 일정을 확정·취소할 수 있게 되고 N-12 가 깨진다.
 */
async function myProfile(ctx: Ctx): Promise<ProfileRow> {
  const p = await principalOf(ctx);
  const row = await one<ProfileRow>(`SELECT id::text AS id, user_id::text AS user_id FROM profiles WHERE user_id = $1`, [
    ctx.userId,
  ]);
  if (!row) throw notFound("profile");
  if (!can(p, "profile.edit", { ownerUserId: row.user_id })) throw forbidden();
  return row;
}

function toRule(r: RuleRow): AvailabilityRule {
  return {
    id: r.id,
    weekday: r.weekday,
    startMin: r.start_min,
    endMin: r.end_min,
    timezone: r.timezone,
    slotMinutes: r.slot_minutes,
  };
}

function toAppointment(r: AppointmentRow): Appointment {
  return {
    id: r.id,
    profileId: r.profile_id,
    leadId: r.lead_id,
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    timezone: r.timezone,
    status: (APPOINTMENT_STATUSES as readonly string[]).includes(r.status)
      ? (r.status as AppointmentStatus)
      : "requested",
    cancellationPolicyVersion: r.cancellation_policy_version,
    canceledAt: r.canceled_at ? r.canceled_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * 시간대 이름을 검증한다. 잘못된 이름을 저장하면 **슬롯 생성 쿼리가 런타임에 터진다**
 * (`AT TIME ZONE 'Asia/Seol'` → 22023). 쓰기 시점에 막는 쪽이 공개 조회를 지키는 길이다.
 */
function assertTimezone(tz: unknown): string {
  if (typeof tz !== "string" || tz.trim() === "") throw badRequest("invalid_timezone", "시간대를 지정하세요.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw badRequest("invalid_timezone", "IANA 시간대 이름이 아닙니다. 예: Asia/Seoul");
  }
  return tz;
}

function normalizeRule(input: AvailabilityRuleInput): Required<AvailabilityRuleInput> {
  const weekday = Number(input?.weekday);
  const startMin = Number(input?.startMin);
  const endMin = Number(input?.endMin);
  const slotMinutes = input?.slotMinutes === undefined ? 30 : Number(input.slotMinutes);

  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw badRequest("invalid_weekday", "weekday 는 0(일)~6(토) 정수입니다.");
  }
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin) || startMin < 0 || endMin > 1440 || endMin <= startMin) {
    throw badRequest("invalid_window", "가용 시간은 0~1440분 범위이고 끝이 시작보다 뒤여야 합니다.");
  }
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > endMin - startMin) {
    throw badRequest("invalid_slot_minutes", "슬롯 길이는 가용 구간보다 짧은 양의 정수여야 합니다.");
  }
  return { weekday, startMin, endMin, slotMinutes, timezone: assertTimezone(input?.timezone) };
}

/**
 * P-120: 주간 패턴을 통째로 교체한다.
 *
 * 왜 전체 교체인가: 부분 수정은 "어떤 규칙이 지금 유효한가"를 호출부가 추적해야 하고, 겹치는 규칙이
 * 남아 중복 슬롯이 생긴다. 한 트랜잭션에서 지우고 다시 넣으면 중간 상태가 공개되지 않는다.
 *
 * 예외일(휴무일) 처리는 아직 스키마가 없다 — P-120 수용기준의 "예외일"은 `availability_rules` 로는
 * 표현되지 않는다. TODO: 예외일 테이블 추가 마이그레이션(추가만 한다, CLAUDE.md §1)과 함께 구현한다.
 *
 * 요금제의 `booking` 플래그(P-141)는 여기서 보지 않는다 — 한도 판정은 M10 의 것이고(`billing.planLimitsFor`)
 * 라우트가 두 모듈을 조립할 때 함께 확인한다. 예약 가능 여부가 결제 상태에 따라 **모듈 안에서** 갈라지면
 * 가용 시간 계산과 과금이 한 함수에 섞인다.
 */
export async function setAvailability(ctx: Ctx, rules: readonly AvailabilityRuleInput[]): Promise<AvailabilityRule[]> {
  const profile = await myProfile(ctx);
  if (!Array.isArray(rules)) throw badRequest("invalid_rules", "규칙 배열이 필요합니다.");
  if (rules.length > MAX_AVAILABILITY_RULES) {
    throw badRequest("too_many_rules", `가용 규칙은 최대 ${MAX_AVAILABILITY_RULES}개입니다.`);
  }
  const normalized = rules.map(normalizeRule);

  return tx(async (c) => {
    await c.query(`DELETE FROM availability_rules WHERE profile_id = $1`, [profile.id]);
    const saved: AvailabilityRule[] = [];
    for (const r of normalized) {
      const inserted = await c.query<RuleRow>(
        `INSERT INTO availability_rules (profile_id, weekday, start_min, end_min, timezone, slot_minutes)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id::text AS id, weekday, start_min, end_min, timezone, slot_minutes`,
        [profile.id, r.weekday, r.startMin, r.endMin, r.timezone, r.slotMinutes],
      );
      const row = inserted.rows[0];
      if (!row) throw conflict("availability_write_failed");
      saved.push(toRule(row));
    }
    return saved;
  });
}

/** P-120: 내 가용 규칙. 소유자 스코프가 WHERE 에 있다. */
export async function getAvailability(ctx: Ctx): Promise<AvailabilityRule[]> {
  const profile = await myProfile(ctx);
  const rows = await q<RuleRow>(
    `SELECT id::text AS id, weekday, start_min, end_min, timezone, slot_minutes
       FROM availability_rules WHERE profile_id = $1
      ORDER BY weekday, start_min`,
    [profile.id],
  );
  return rows.map(toRule);
}

function toDateOnly(v: string | Date, what: string): string {
  const d = v instanceof Date ? v : new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid_date", `${what} 을(를) 해석할 수 없습니다.`);
  return d.toISOString().slice(0, 10);
}

/** P-123: 지금 유효한 취소 정책 버전. 예약에 **버전을 박아** 두면 나중에 정책이 바뀌어도 당시 약속이 남는다. */
async function currentCancellationPolicy(): Promise<string | null> {
  const row = await one<{ version: string }>(
    `SELECT version FROM policy_versions
      WHERE kind = 'cancellation' AND effective_at <= now()
      ORDER BY effective_at DESC
      LIMIT 1`,
  );
  return row?.version ?? null;
}

/**
 * P-120/P-121: 공개 슬롯 조회. 인증이 없으므로 `Ctx` 를 받지 않고, 프로필은 **`public_profile_view`**
 * 로만 해석한다 (N-4: 비공개 프로필의 일정이 slug 추측으로 드러나지 않게).
 *
 * 이미 잡힌 예약은 `tstzrange && tstzrange` 로 뺀다 — 겹침 판정 기준을 DB 배타 제약과 **같은 연산자**로
 * 맞추는 것이 중요하다. 다른 기준으로 빼면 "화면에는 비었는데 예약하면 409" 가 된다.
 *
 * `DISTINCT` 를 쓰는 이유: 같은 요일에 겹치는 규칙이 두 개 있으면 같은 슬롯이 두 번 생성된다.
 */
export async function availableSlots(
  slug: string,
  fromDate: string | Date,
  toDate: string | Date,
  now: Date = new Date(),
): Promise<SlotList> {
  if (typeof slug !== "string" || slug.trim() === "") throw badRequest("invalid_slug");
  const from = toDateOnly(fromDate, "fromDate");
  const to = toDateOnly(toDate, "toDate");
  if (to < from) throw badRequest("invalid_period", "toDate 는 fromDate 보다 뒤여야 합니다.");
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  if (spanDays > MAX_SLOT_RANGE_DAYS) {
    throw badRequest("range_too_long", `슬롯 조회 범위는 최대 ${MAX_SLOT_RANGE_DAYS}일입니다.`);
  }

  const profile = await one<{ id: string }>(`SELECT id::text AS id FROM public_profile_view WHERE slug = $1`, [slug]);
  if (!profile) throw notFound("profile");

  const rows = await q<{ start_at: Date; end_at: Date; timezone: string }>(
    `WITH days AS (
       -- ::timestamp 로 못 박는다: generate_series(date, date, interval) 는 timestamp/timestamptz 두 후보로
       -- 해석될 수 있고, timestamptz 로 풀리면 일자 경계가 **세션 시간대**에 따라 흔들린다.
       SELECT dd::date AS day
         FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') AS dd
     ), gen AS (
       SELECT ((d.day + make_interval(mins => (r.start_min + g.m)::int)) AT TIME ZONE r.timezone)                   AS start_at,
              ((d.day + make_interval(mins => (r.start_min + g.m + r.slot_minutes)::int)) AT TIME ZONE r.timezone)  AS end_at,
              r.timezone AS timezone
         FROM days d
         JOIN availability_rules r
           ON r.profile_id = $1
          AND r.weekday = EXTRACT(DOW FROM d.day)::smallint
        CROSS JOIN LATERAL generate_series(0, (r.end_min - r.start_min - r.slot_minutes)::int, r.slot_minutes::int) AS g(m)
     )
     SELECT DISTINCT g.start_at, g.end_at, g.timezone
       FROM gen g
      WHERE g.start_at >= $4::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM appointments a
           WHERE a.profile_id = $1
             AND a.status = ANY($5::text[])
             AND tstzrange(a.start_at, a.end_at) && tstzrange(g.start_at, g.end_at)
        )
      ORDER BY g.start_at
      LIMIT $6`,
    [profile.id, from, to, now.toISOString(), BLOCKING_STATUSES, MAX_SLOTS],
  );

  return {
    period: { from, to },
    cancellationPolicyVersion: await currentCancellationPolicy(),
    slots: rows.map((r) => ({
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      timezone: r.timezone,
    })),
  };
}

/** 워커의 `notifyOnce` 와 같은 멱등 규칙(P-184): 같은 `(user_id, kind, link)` 알림은 한 번만 넣는다. */
async function notifyOnce(
  c: PoolClient,
  userId: string,
  n: { kind: string; title: string; body?: string | null; link: string },
): Promise<void> {
  await c.query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT $1,$2,$3,$4,$5
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id=$1 AND kind=$2 AND link=$5)`,
    [userId, n.kind, n.title, n.body ?? null, n.link],
  );
}

/**
 * P-121/P-122/P-124: 예약 요청. 비회원도 호출한다(`ctx.userId === null`).
 *
 * 순서가 의미를 가진다:
 *   1. rate limit — 공개 쓰기 경로다. 버킷은 `lead.create` 와 공유한다(같은 "비회원이 남기는 요청"이다).
 *   2. 슬롯 격자 검증 — 가용 규칙 밖 시각, 격자에 맞지 않는 시각, 초 단위가 섞인 시각을 거부한다.
 *      이 검증이 없으면 "표시된 적 없는 슬롯"으로 예약이 들어온다.
 *   3. 사전 겹침 검사 — 친절한 메시지를 위한 것이고, **실제 방어선은 아니다**(파일 상단 주석).
 *   4. tx: INSERT + `appointment.booked` outbox + 소유자 알림. 셋이 같은 트랜잭션이어야
 *      "예약은 들어왔는데 아무도 모른다"가 생기지 않는다 (P-183).
 */
export async function requestAppointment(
  ctx: Ctx,
  slug: string,
  input: AppointmentRequestInput,
): Promise<Appointment> {
  if (typeof slug !== "string" || slug.trim() === "") throw badRequest("invalid_slug");
  await consumeLimit("lead.create", ctx.userId ?? ctx.ip);

  const startAt = input?.startAt instanceof Date ? input.startAt : new Date(String(input?.startAt));
  if (Number.isNaN(startAt.getTime())) throw badRequest("invalid_start", "예약 시작 시각을 해석할 수 없습니다.");
  if (startAt.getTime() <= Date.now()) throw badRequest("slot_in_past", "지난 시각은 예약할 수 없습니다.");

  const profile = await one<ProfileRow>(
    `SELECT v.id::text AS id, p.user_id::text AS user_id
       FROM public_profile_view v
       JOIN profiles p ON p.id = v.id
      WHERE v.slug = $1`,
    [slug],
  );
  if (!profile) throw notFound("profile");

  // 2. 가용 규칙의 슬롯 격자에 맞는가. 지역 시각 환산은 Postgres 가 한다(DST 포함).
  const match = await one<{ timezone: string; slot_minutes: number }>(
    `SELECT r.timezone, r.slot_minutes
       FROM availability_rules r
       CROSS JOIN LATERAL (SELECT ($2::timestamptz AT TIME ZONE r.timezone) AS local_ts) l
       CROSS JOIN LATERAL (
         SELECT (EXTRACT(HOUR FROM l.local_ts) * 60 + EXTRACT(MINUTE FROM l.local_ts))::int AS mins,
                EXTRACT(SECOND FROM l.local_ts)::int                                        AS secs,
                EXTRACT(DOW FROM l.local_ts)::smallint                                      AS dow
       ) t
      WHERE r.profile_id = $1
        AND r.weekday = t.dow
        AND t.secs = 0
        AND t.mins >= r.start_min
        AND t.mins <= r.end_min - r.slot_minutes
        AND ((t.mins - r.start_min) % r.slot_minutes) = 0
      ORDER BY r.slot_minutes
      LIMIT 1`,
    [profile.id, startAt.toISOString()],
  );
  if (!match) throw badRequest("slot_unavailable", "선택한 시각은 예약 가능한 슬롯이 아닙니다.");
  const endAt = new Date(startAt.getTime() + match.slot_minutes * 60_000);

  // P-094: 리드 연결. uuid 를 아는 쪽만 넘길 수 있고, **같은 프로필의 리드**인지 반드시 확인한다(IDOR 차단).
  let leadId: string | null = null;
  if (input?.leadId) {
    const lead = await one<{ id: string }>(`SELECT id::text AS id FROM leads WHERE id = $1 AND profile_id = $2`, [
      input.leadId,
      profile.id,
    ]);
    if (!lead) throw notFound("lead");
    leadId = lead.id;
  }

  const policyVersion = await currentCancellationPolicy();
  if (!policyVersion) {
    // P-123: 취소 정책 없이 예약을 받지 않는다. 정책 버전이 없으면 취소 조건을 사후에 지어내게 된다.
    throw unavailable("cancellation_policy_missing", "취소 정책이 설정되지 않아 예약을 받을 수 없습니다.");
  }

  // 3. 사전 검사(친절한 메시지용).
  const taken = await one<{ one: number }>(
    `SELECT 1 AS one FROM appointments
      WHERE profile_id = $1 AND status = ANY($4::text[])
        AND tstzrange(start_at, end_at) && tstzrange($2::timestamptz, $3::timestamptz)
      LIMIT 1`,
    [profile.id, startAt.toISOString(), endAt.toISOString(), BLOCKING_STATUSES],
  );
  if (taken) throw conflict("slot_taken", "이미 예약된 시간입니다.");

  try {
    return await tx(async (c) => {
      const inserted = await c.query<AppointmentRow>(
        `INSERT INTO appointments
           (profile_id, lead_id, start_at, end_at, timezone, status, cancellation_policy_version)
         VALUES ($1,$2,$3,$4,$5,'requested',$6)
         RETURNING id::text AS id, profile_id::text AS profile_id, lead_id::text AS lead_id,
                   start_at, end_at, timezone, status, cancellation_policy_version, canceled_at, created_at`,
        [profile.id, leadId, startAt.toISOString(), endAt.toISOString(), match.timezone, policyVersion],
      );
      const row = inserted.rows[0];
      if (!row) throw conflict("appointment_write_failed");

      await enqueue(c, {
        eventType: "appointment.booked",
        aggregateType: "appointment",
        aggregateId: row.id,
        actorId: ctx.userId,
        correlationId: ctx.requestId,
        // 식별자와 시각만. 방문자 이름·연락처는 리드 쪽에 있고 이벤트에 담지 않는다 (N-13).
        payload: { profileId: row.profile_id, leadId: row.lead_id, startAt: row.start_at.toISOString() },
      });

      // P-124: 알림 본문에 고객 정보를 쓰지 않는다. 내용은 워크스페이스에서 권한 확인 후 본다.
      await notifyOnce(c, profile.user_id, {
        kind: "appointment.requested",
        title: "새 예약 요청",
        body: "예약 목록에서 확인하세요.",
        link: `/app/appointments/${row.id}`,
      });

      return toAppointment(row);
    });
  } catch (e) {
    // P-122: 동시 요청은 여기로 떨어진다 — 배타 제약이 거부한 것이다.
    if ((e as { code?: string })?.code === "23P01") {
      throw conflict("slot_taken", "이미 예약된 시간입니다.");
    }
    throw e;
  }
}

/**
 * P-123: 예약 확인. `requested` 에서만 `confirmed` 로 간다 — 취소된 예약을 되살리는 경로를 만들면
 * 배타 제약과 충돌하는 상태(취소된 줄 알았던 시간에 두 건)가 생긴다.
 *
 * outbox 이벤트를 넣지 않는 이유: 이벤트 카탈로그(기술백서 §7)에 `appointment.confirmed` 가 없다.
 * 상태 변경 사실은 `audit_logs` 에 남긴다 — 카탈로그 밖 이름은 `buildEnvelope()` 가 거부하고,
 * 이벤트 추가는 소비자와 함께 고치는 별도 PR 이어야 한다.
 */
export async function confirmAppointment(ctx: Ctx, id: string): Promise<Appointment> {
  const profile = await myProfile(ctx);

  return tx(async (c) => {
    const r = await c.query<AppointmentRow>(
      `UPDATE appointments
          SET status = 'confirmed'
        WHERE id = $1 AND profile_id = $2 AND status = 'requested'
        RETURNING id::text AS id, profile_id::text AS profile_id, lead_id::text AS lead_id,
                  start_at, end_at, timezone, status, cancellation_policy_version, canceled_at, created_at`,
      [id, profile.id],
    );
    const row = r.rows[0];
    if (!row) {
      // 소유자 스코프를 통과하지 못했거나 상태가 맞지 않는다. 둘을 구분해 응답한다.
      const exists = await c.query<{ status: string }>(
        `SELECT status FROM appointments WHERE id = $1 AND profile_id = $2`,
        [id, profile.id],
      );
      const current = exists.rows[0];
      if (!current) throw notFound("appointment");
      throw conflict("not_confirmable", `상태가 ${current.status} 인 예약은 확인할 수 없습니다.`);
    }

    await writeAudit(c, {
      eventType: "appointment.confirmed",
      actorId: ctx.userId,
      aggregateType: "appointment",
      aggregateId: row.id,
      payload: { profileId: row.profile_id, startAt: row.start_at.toISOString() },
      correlationId: ctx.requestId,
    });
    return toAppointment(row);
  });
}

/**
 * P-123: 예약 취소. `by` 는 **누가 요청했는지의 기록**이고 권한 판정이 아니다.
 *
 * 권한은 항상 프로필 소유자 세션으로 확인한다. 게스트가 직접 취소하려면 1회성 토큰이 필요하고
 * `appointments` 에는 토큰 컬럼이 없다 — 토큰 없는 게스트 취소 경로를 만들면 uuid 를 아는 누구나
 * 남의 예약을 취소할 수 있다(IDOR). 그래서 지금은 방문자 요청을 소유자가 대신 반영하고 `by='visitor'` 로 남긴다.
 * TODO(P-125 와 함께): 게스트 취소 링크용 `appointment_tokens` 추가 마이그레이션 후 공개 취소 경로를 연다.
 *
 * 취소도 outbox 이벤트가 없다(카탈로그에 `appointment.canceled` 가 없다) — `audit_logs` 에 남긴다.
 */
export async function cancelAppointment(ctx: Ctx, id: string, by: CancelActor = "owner"): Promise<Appointment> {
  const profile = await myProfile(ctx);
  const actor: CancelActor = by === "visitor" || by === "system" ? by : "owner";

  return tx(async (c) => {
    const r = await c.query<AppointmentRow>(
      `UPDATE appointments
          SET status = 'canceled', canceled_at = now()
        WHERE id = $1 AND profile_id = $2 AND status = ANY($3::text[])
        RETURNING id::text AS id, profile_id::text AS profile_id, lead_id::text AS lead_id,
                  start_at, end_at, timezone, status, cancellation_policy_version, canceled_at, created_at`,
      [id, profile.id, BLOCKING_STATUSES],
    );
    const row = r.rows[0];
    if (!row) {
      const exists = await c.query<{ status: string }>(
        `SELECT status FROM appointments WHERE id = $1 AND profile_id = $2`,
        [id, profile.id],
      );
      const current = exists.rows[0];
      if (!current) throw notFound("appointment");
      throw conflict("not_cancelable", `상태가 ${current.status} 인 예약은 취소할 수 없습니다.`);
    }

    await writeAudit(c, {
      eventType: "appointment.canceled",
      actorId: ctx.userId,
      aggregateType: "appointment",
      aggregateId: row.id,
      payload: {
        profileId: row.profile_id,
        requestedBy: actor,
        // 당시 약속이 무엇이었는지 복원할 수 있어야 한다 (P-123).
        cancellationPolicyVersion: row.cancellation_policy_version,
      },
      correlationId: ctx.requestId,
    });
    return toAppointment(row);
  });
}

// TODO(P-125): ICS 내보내기. 시간대를 포함한 표준 ICS 는 `VTIMEZONE` 블록이 필요하고,
//   `domain/vcard.ts` 와 같은 자리에 순수 함수(`buildICS`)로 두는 것이 맞다 — I/O 가 없기 때문이다.
// TODO(P-126 / ADR-006): 외부 캘린더 연동은 어댑터만 둔다. Cal.com 라이선스 실사가 끝나지 않았다.
