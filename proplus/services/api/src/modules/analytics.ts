/**
 * M09 Analytics — P-130 조회 기록 · P-131 CTA 클릭 · P-132 상담 전환 · P-133 예약 전환 ·
 * P-134 UTM 귀속 · P-135 기간별 요약 · P-136 배지 조회.
 *
 * 출처: 모듈명세 M09("개인식별 데이터는 최소화하고 집계 기준·기간을 명시한다")
 *       + ADR-006(Umami 실사 전 폴백 = 자체 `analytics_events` 집계).
 *
 * ## 이 파일의 두 축
 *
 * 1. **N-13 — 원문을 저장하지 않는다.** `track()` 은 IP·UA 를 받지만 **쓰지 않는다**:
 *    `hashVisitor(ip, ua, salt)` 의 결과만 넣고, referrer 는 **호스트만** 남기고 경로·질의문자열을 버린다
 *    (경로·쿼리에 이름·이메일·검색어가 실려 오는 일이 흔하다 — 보안정책 §3).
 *    salt 가 없으면 **해시를 저장하지 않는다**(null). "소금 없는 IP 해시"는 IPv4 전수대입으로 복원되므로
 *    그런 값을 남기는 것은 원문을 남기는 것과 다르지 않다.
 * 2. **집계는 기준과 기간을 함께 말한다** (M09 수용기준 / N-8 과 같은 정신).
 *    `summary`·`conversionFunnel` 은 수치만 돌려주지 않고 `{ period, basis, ... }` 를 돌려준다.
 *    분모가 0 이면 전환율은 `0` 이 아니라 `null` 이다 — "0%"와 "표본 없음"은 다른 사실이다.
 */

import { can, hashVisitor, redactString, sanitizeText } from "@proplus/domain";
import type { MemberRole, PlatformRole, Principal } from "@proplus/domain";
import type { Ctx } from "../lib/ctx";
import { one, q } from "../lib/db";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { consumeLimit } from "../lib/limits";
import { log } from "../lib/log";
import { planLimitsFor } from "./billing";

/**
 * 기록 가능한 사건 — **닫힌 집합이다.** 자유 문자열을 허용하면 `kind` 에 "lead:hong@example.com" 같은
 * 값이 들어오고(실제로 들어온다) 그 순간 N-13 이 깨진다. 새 사건은 이 배열과 집계 쿼리를 같이 고친다.
 */
export const ANALYTICS_KINDS = [
  "profile_view",
  "cta_click",
  "lead_submit",
  "appointment_booked",
  "badge_view",
  "offer_view",
  "vcard_download",
  /** P-156: 검색 zero-result. 기록 주체는 M11(`modules/search.ts`)이고 범주만 담는다. */
  "search.zero_result",
] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

/** P-134: 귀속에 쓰는 UTM 키만 남긴다. 나머지 쿼리 파라미터는 버린다 — 개인정보가 섞여 들어올 통로를 줄인다. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

const TARGET_MAX = 120;
const UTM_VALUE_MAX = 120;

/** 퍼널 단계 순서 (M09 수용기준: 조회→상담→예약). 이 순서가 전환율의 분모/분자를 정의한다. */
export const FUNNEL_STAGES = [
  { kind: "profile_view", label: "프로필 조회" },
  { kind: "cta_click", label: "CTA 클릭" },
  { kind: "lead_submit", label: "상담 제출" },
  { kind: "appointment_booked", label: "예약 완료" },
] as const;

/**
 * 집계 기준 문구. 응답에 함께 실어 보낸다 (M09 수용기준).
 * 숫자만 보내면 "고유 방문자"가 쿠키 기준인지 해시 기준인지, 봇이 섞였는지 아무도 모른다.
 */
export const SUMMARY_BASIS =
  "analytics_events 원시 이벤트 집계 · 고유 방문자는 (IP+UA+salt) 해시 기준 · 일 단위는 UTC 경계 · 봇 필터 없음";
export const FUNNEL_BASIS =
  "analytics_events 단계별 이벤트 수 집계 · 같은 방문자의 반복 행동도 각각 센다 · 분모가 0 이면 전환율은 null";

export interface TrackInput {
  kind: string;
  /** 공개 경로는 slug 로 온다. `public_profile_view` 로 해석하므로 비공개 프로필은 기록되지 않는다. */
  slug?: string | null;
  profileId?: string | null;
  /** 무엇이 눌렸는지(식별자·코드). 사람 이름·연락처를 넣는 자리가 아니다. */
  target?: string | null;
  /** 저장하지 않는다 — 해시와 rate limit 버킷 재료로만 쓴다 (N-13). */
  ip: string;
  userAgent: string;
  referrer?: string | null;
  utm?: Record<string, unknown> | null;
  occurredAt?: Date;
}

export interface Period {
  from: string;
  to: string;
  /** 요청한 시작 시각. 요금제 보관 기간 때문에 잘렸는지 비교할 수 있어야 한다 (P-141). */
  requestedFrom: string;
  clampedByPlan: boolean;
  planCode: string;
  retentionDays: number;
}

export interface SummaryResult {
  period: Period;
  basis: string;
  metrics: {
    views: number;
    uniqueVisitors: number;
    ctaClicks: number;
    leadSubmits: number;
    appointmentsBooked: number;
    badgeViews: number;
    offerViews: number;
    byDay: { day: string; kind: AnalyticsKind | string; count: number }[];
    topReferrers: { host: string; count: number }[];
  };
}

export interface FunnelStageResult {
  stage: string;
  label: string;
  count: number;
  /** 직전 단계 대비 전환율(0~1). 분모가 0 이면 null. */
  fromPrevious: number | null;
  /** 첫 단계 대비 전환율(0~1). 분모가 0 이면 null. */
  fromTop: number | null;
}

export interface FunnelResult {
  period: Period;
  basis: string;
  stages: FunnelStageResult[];
}

type UserRow = { platform_role: PlatformRole };
type MembershipRow = { organization_id: string; role: MemberRole; status: string };
type ProfileRow = { id: string; user_id: string };

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
 * 통계는 **자기 프로필의 것만** 본다. ACL 에 analytics 전용 능력이 없어 본인 판정에 `profile.edit` 를 쓴다
 * (조직 관리자·플랫폼 운영자에게 열어 주지 않는다 — 운영자의 데이터 조회는 접근 사유를 남기는
 * 별도 경로 P-165 를 거친다). TODO: `analytics.read` 능력 추가는 `domain/acl.ts` 소유자 PR 로.
 */
async function myProfileForRead(ctx: Ctx): Promise<ProfileRow> {
  const p = await principalOf(ctx);
  const row = await one<ProfileRow>(`SELECT id::text AS id, user_id::text AS user_id FROM profiles WHERE user_id = $1`, [
    ctx.userId,
  ]);
  if (!row) throw notFound("profile");
  if (!can(p, "profile.edit", { ownerUserId: row.user_id })) throw forbidden();
  return row;
}

/** N-13: salt 없는 방문자 해시는 만들지 않는다. 운영 env 에 `ANALYTICS_SALT` 를 넣고 주기적으로 교체한다. */
function visitorSalt(): string | null {
  const salt = process.env.ANALYTICS_SALT ?? process.env.AUTH_SECRET;
  return salt && salt.length > 0 ? salt : null;
}

/**
 * referrer 에서 **호스트만** 꺼낸다. 경로·쿼리는 버린다 — 유입 분석에 필요한 것은 "어디서 왔나"이고,
 * 경로·쿼리에는 검색어·이름·토큰이 실려 온다 (보안정책 §3 / N-13).
 */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().slice(0, 253) || null;
  } catch {
    return null;
  }
}

/** P-134: 허용된 UTM 키만, 길이 제한과 무해화를 거쳐 남긴다. */
export function normalizeUtm(utm: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!utm) return out;
  for (const key of UTM_KEYS) {
    const raw = utm[key];
    if (typeof raw !== "string") continue;
    const value = sanitizeText(raw, UTM_VALUE_MAX);
    if (value) out[key] = value;
  }
  return out;
}

function isAnalyticsKind(v: string): v is AnalyticsKind {
  return (ANALYTICS_KINDS as readonly string[]).includes(v);
}

/**
 * P-130/P-131/P-136: 사건 하나를 기록한다.
 *
 * `Ctx` 를 받지 않고 `ip`·`userAgent` 를 입력으로 받는 이유: 이 경로는 비회원 비콘이고,
 * 세션이 없는 호출이 기본이다. 그래서 "요청 문맥"보다 "방문자 재료"가 필요한 것이 전부다.
 *
 * 프로필을 해석할 수 없으면 `{recorded:false}` 로 조용히 끝낸다 — 비콘에 404 를 돌려줘도
 * 브라우저가 할 수 있는 일이 없고, 공개되지 않은 프로필의 조회를 기록할 이유도 없다.
 */
export async function track(input: TrackInput): Promise<{ recorded: boolean }> {
  if (typeof input?.kind !== "string" || !isAnalyticsKind(input.kind)) {
    throw badRequest("unknown_kind", "기록할 수 없는 사건 종류입니다.");
  }
  const kind: AnalyticsKind = input.kind;

  let profileId: string | null = null;
  if (input.profileId || input.slug) {
    // N-4: 공개 뷰로만 해석한다. 비공개·삭제 프로필의 사건은 기록하지 않는다.
    const row = input.profileId
      ? await one<{ id: string }>(`SELECT id::text AS id FROM public_profile_view WHERE id = $1`, [input.profileId])
      : await one<{ id: string }>(`SELECT id::text AS id FROM public_profile_view WHERE slug = $1`, [input.slug]);
    if (!row) return { recorded: false };
    profileId = row.id;
  }

  // P-189: 공개 쓰기 경로이므로 한도를 건다. 버킷은 공개 조회와 같은 `public.view` 다 —
  // 같은 방문자의 조회·클릭을 하나의 예산으로 묶는 쪽이 비콘 남용을 막는 데 맞다.
  const salt = visitorSalt();
  const visitorHash = salt ? hashVisitor(input.ip ?? "", input.userAgent ?? "", salt) : null;
  if (!salt) log("warn", "analytics.salt_missing", { kind });
  await consumeLimit("public.view", visitorHash ?? input.ip ?? "unknown");

  // target 은 식별자여야 하지만 호출부를 믿지 않는다: 무해화 + redact 를 거쳐 PII 원문이 남지 않게 한다 (N-13).
  const target = input.target ? redactString(sanitizeText(input.target, TARGET_MAX)) : null;

  await q(
    `INSERT INTO analytics_events (profile_id, kind, target, visitor_hash, referrer_host, utm, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, COALESCE($7::timestamptz, now()))`,
    [
      profileId,
      kind,
      target,
      visitorHash,
      referrerHost(input.referrer),
      JSON.stringify(normalizeUtm(input.utm)),
      input.occurredAt ?? null,
    ],
  );
  return { recorded: true };
}

function parseInstant(v: Date | string, what: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid_date", `${what} 을(를) 해석할 수 없습니다.`);
  return d;
}

/**
 * P-141: 요금제의 `analyticsDays` 만큼만 과거를 본다. **잘렸다는 사실을 응답에 적는다**(`clampedByPlan`) —
 * 조용히 자르면 사용자는 "데이터가 없다"와 "요금제가 가린다"를 구분할 수 없다.
 */
async function resolvePeriod(ctx: Ctx, from: Date | string, to: Date | string): Promise<Period> {
  const requestedFrom = parseInstant(from, "from");
  const end = parseInstant(to, "to");
  if (end.getTime() <= requestedFrom.getTime()) throw badRequest("invalid_period", "to 는 from 보다 뒤여야 합니다.");

  const plan = await planLimitsFor(ctx);
  const retentionDays = plan.limits.analyticsDays;
  const floor = new Date(end.getTime() - retentionDays * 86_400_000);
  const start = requestedFrom.getTime() < floor.getTime() ? floor : requestedFrom;

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    requestedFrom: requestedFrom.toISOString(),
    clampedByPlan: start.getTime() !== requestedFrom.getTime(),
    planCode: plan.planCode,
    retentionDays,
  };
}

/** P-135: 기간별 요약. 집계 기준·기간을 수치와 **함께** 돌려준다 (M09 수용기준). */
export async function summary(ctx: Ctx, from: Date | string, to: Date | string): Promise<SummaryResult> {
  const profile = await myProfileForRead(ctx);
  const period = await resolvePeriod(ctx, from, to);

  const totals = await one<{
    views: number;
    unique_visitors: number;
    cta_clicks: number;
    lead_submits: number;
    appointments: number;
    badge_views: number;
    offer_views: number;
  }>(
    `SELECT
       (count(*) FILTER (WHERE kind = 'profile_view'))::int                                    AS views,
       (count(DISTINCT visitor_hash) FILTER (WHERE kind = 'profile_view'
                                               AND visitor_hash IS NOT NULL))::int              AS unique_visitors,
       (count(*) FILTER (WHERE kind = 'cta_click'))::int                                        AS cta_clicks,
       (count(*) FILTER (WHERE kind = 'lead_submit'))::int                                      AS lead_submits,
       (count(*) FILTER (WHERE kind = 'appointment_booked'))::int                               AS appointments,
       (count(*) FILTER (WHERE kind = 'badge_view'))::int                                       AS badge_views,
       (count(*) FILTER (WHERE kind = 'offer_view'))::int                                       AS offer_views
     FROM analytics_events
     WHERE profile_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
    [profile.id, period.from, period.to],
  );

  const byDay = await q<{ day: string; kind: string; count: number }>(
    `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            kind,
            count(*)::int AS count
       FROM analytics_events
      WHERE profile_id = $1 AND occurred_at >= $2 AND occurred_at < $3
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [profile.id, period.from, period.to],
  );

  const topReferrers = await q<{ host: string; count: number }>(
    `SELECT referrer_host AS host, count(*)::int AS count
       FROM analytics_events
      WHERE profile_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND referrer_host IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC, host
      LIMIT 10`,
    [profile.id, period.from, period.to],
  );

  return {
    period,
    basis: SUMMARY_BASIS,
    metrics: {
      views: totals?.views ?? 0,
      uniqueVisitors: totals?.unique_visitors ?? 0,
      ctaClicks: totals?.cta_clicks ?? 0,
      leadSubmits: totals?.lead_submits ?? 0,
      appointmentsBooked: totals?.appointments ?? 0,
      badgeViews: totals?.badge_views ?? 0,
      offerViews: totals?.offer_views ?? 0,
      byDay,
      topReferrers,
    },
  };
}

/** 분모가 0 이면 null. 소수 네 자리로 고정해 응답 diff 가 부동소수 꼬리로 흔들리지 않게 한다. */
function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * P-132/P-133: 전환 퍼널 — profile_view → cta_click → lead_submit → appointment_booked.
 *
 * 네 단계를 모두 `analytics_events` **한 가지 기준**으로 센다. `leads`·`appointments` 실제 건수와
 * 다를 수 있다(이벤트가 유실되거나, 운영자가 수동으로 만든 리드는 이벤트가 없다) —
 * 그래서 두 출처를 섞지 않고 기준을 `basis` 에 적어 내보낸다. 섞으면 분모와 분자가 다른 세계의 숫자가 된다.
 */
export async function conversionFunnel(ctx: Ctx, from: Date | string, to: Date | string): Promise<FunnelResult> {
  const profile = await myProfileForRead(ctx);
  const period = await resolvePeriod(ctx, from, to);

  const rows = await q<{ kind: string; count: number }>(
    `SELECT kind, count(*)::int AS count
       FROM analytics_events
      WHERE profile_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND kind = ANY($4::text[])
      GROUP BY kind`,
    [profile.id, period.from, period.to, FUNNEL_STAGES.map((s) => s.kind)],
  );
  const counts = new Map<string, number>(rows.map((r) => [r.kind, r.count]));

  const top = counts.get(FUNNEL_STAGES[0].kind) ?? 0;
  const stages: FunnelStageResult[] = FUNNEL_STAGES.map((stage, i) => {
    const count = counts.get(stage.kind) ?? 0;
    const previousStage = i > 0 ? FUNNEL_STAGES[i - 1] : undefined;
    const previous = previousStage ? (counts.get(previousStage.kind) ?? 0) : null;
    return {
      stage: stage.kind,
      label: stage.label,
      count,
      fromPrevious: previous === null ? null : rate(count, previous),
      fromTop: i === 0 ? null : rate(count, top),
    };
  });

  return { period, basis: FUNNEL_BASIS, stages };
}
