/**
 * M10 Billing & Plans — P-140 요금제 정의 · P-141 한도 적용 · P-142 구독 상태 · P-143 해지 후 데이터 접근.
 *
 * 출처: dd/PROPLUS_Technical_Document_Set 모듈명세 M10 / 기획서 §9 수익모델 / 전략 §8 "비워 둔 것".
 *
 * ## 이 모듈이 **하지 않는** 것 세 가지
 *
 * 1. **`proof` 모듈을 import 하지 않는다** (N-2 / CLAUDE.md §3 import 방향).
 *    배지·검증 경로는 구독을 모르고, 이 모듈은 배지를 모른다. 한쪽 방향이라도 열리면
 *    "Pro 면 검토가 빠르다 / 배지 슬롯이 늘어난다" 같은 분기가 들어올 자리가 생기고,
 *    그 순간 PROPLUS 가 파는 신뢰 자체가 상품이 된다. `PlanLimits` 에 배지 키가 하나도 없는 것
 *    (`domain/plans.ts`)과 `canIssueBadge()` 가 구독을 인자로도 받지 않는 것이 같은 규칙의 다른 쪽 짝이다.
 * 2. **결제를 하지 않는다.** PG·정산·환불 요건이 미결정이다 (전략 §8 / P-144). `setSubscription` 은
 *    내부·관리자용 기록 경로이고, 외부 결제 연동 자리는 아래 TODO 주석으로만 남긴다.
 * 3. **다른 모듈의 테이블을 쓰지 않는다.** 해지가 공개 프로필을 내리지 않는 이유가 이것이다 —
 *    `profiles.published_at` 은 M02 의 것이다. 대신 해지 효과를 반환값(`POST_CANCEL_POLICY`)으로 명시한다.
 *
 * 한도 값은 코드 상수가 아니라 `plans.limits` jsonb 레코드에서 온다 (P-140) — 요금제 변경이 배포를 요구하지 않게.
 */

import { can } from "@proplus/domain";
import type { MemberRole, PlanLimits, PlatformRole, Principal } from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";

/** 구독이 없을 때의 요금제. 가입 즉시 쓸 수 있는 범위가 여기다 (기획서 §9). */
export const DEFAULT_PLAN_CODE = "free";

export const SUBSCRIPTION_STATUSES = ["active", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * 요금제 레코드를 읽을 수 없을 때 쓰는 값. **fail-closed** 다 — 한도를 모르면 "무제한"이 아니라 "0" 이다.
 * 한도 조회 실패가 조용히 무제한이 되면, 장애 중에 요금제가 사라지는 셈이 된다.
 */
const CONSERVATIVE_LIMITS: PlanLimits = {
  offers: 0,
  blocks: 0,
  customDomain: false,
  booking: false,
  analyticsDays: 0,
};

/**
 * P-143 해지 후 데이터 접근 정책.
 *
 * 문서(모듈명세 M10 수용기준)가 요구하는 것은 "공개 중단 기준과 내보내기 가능 기간을 명시한다" 다.
 * 그래서 값을 **반환값으로** 내보낸다 — 화면이 자기 문구를 지어내지 않고 이 상수를 그린다.
 *
 * `badges: "unaffected"` 가 N-2 의 해지 쪽 얼굴이다: 결제가 끊겨도 이미 검증된 사실은 사실이다.
 * 공개는 멈추지만 배지를 삭제·만료시키지 않는다 — 만료는 검증 유효기간만이 결정한다(N-9).
 * `exportWindowDays` 는 **비워 둔다**: 보유기간은 법률검토 후 주입한다 (`retention_policies`, P-199 / 미결정 §2).
 */
export const POST_CANCEL_POLICY = {
  /** 공개 프로필·공개 카탈로그 노출을 중단한다. 실제 비공개 전환은 M02 가 수행한다(아래 TODO). */
  publicExposure: "suspended",
  /** 워크스페이스는 열린다. 자기 데이터를 꺼내지 못하게 잠그지 않는다 (모듈명세 M10 수용기준). */
  workspaceAccess: "read_only",
  /** 내보내기는 가능하다. 기간은 법률검토 전이므로 null — "무기한"이 아니라 "미결정"이다. */
  dataExport: "available",
  exportWindowDays: null,
  /** N-2: 배지는 결제로 얻는 것이 아니므로 결제 중단으로 사라지지도 않는다. */
  badges: "unaffected",
} as const;

export interface PlanRecord {
  code: string;
  name: string;
  limits: PlanLimits;
}

export interface SubscriptionRecord {
  id: string;
  planCode: string;
  status: SubscriptionStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface EffectivePlan {
  planCode: string;
  planName: string;
  limits: PlanLimits;
  /** 구독 상태. 구독 레코드가 없으면 null 이고 planCode 는 기본 요금제다. */
  subscriptionStatus: SubscriptionStatus | null;
  /** 한도의 출처. 화면·로그가 "왜 이 한도인지" 말할 수 있어야 한다. */
  source: "subscription" | "default";
}

type PlanRow = { code: string; name: string; limits: unknown };
type SubscriptionRow = {
  id: string;
  plan_code: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
};
type UserRow = { platform_role: PlatformRole };
type MembershipRow = { organization_id: string; role: MemberRole; status: string };

/**
 * 권한 판정에 필요한 Principal 을 DB 에서 조립한다 (CLAUDE.md §3: 모듈은 권한을 **계산하지 않고** `can()` 에 묻는다).
 * 모듈마다 같은 조립 코드가 있는 것은 의도적이다 — 모듈 간 import 로 결합을 만들지 않는다.
 */
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
 * jsonb → `PlanLimits`. 모르는 키는 버리고, 없는 키는 보수적 기본값으로 채운다.
 *
 * 왜 캐스팅(`as PlanLimits`)으로 끝내지 않는가: `plans.limits` 는 운영자가 고치는 jsonb 다.
 * 오타 하나가 `undefined` 한도가 되어 `withinLimit()` 에 들어가면 안 된다 — 그래서 여기서 좁힌다.
 * 배지 관련 키는 읽지도 않는다 (N-2): 누가 `plans.limits` 에 `badgeSlots` 를 넣어도 코드가 무시한다.
 */
export function toPlanLimits(raw: unknown): PlanLimits {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...CONSERVATIVE_LIMITS };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

  const limits: PlanLimits = {
    offers: num(r.offers, CONSERVATIVE_LIMITS.offers),
    blocks: num(r.blocks, CONSERVATIVE_LIMITS.blocks),
    customDomain: r.customDomain === true,
    booking: r.booking === true,
    analyticsDays: num(r.analyticsDays, CONSERVATIVE_LIMITS.analyticsDays),
  };
  // teamSeats 는 optional 이다 — "0석"과 "그 요금제에 좌석 개념이 없음"을 구분해야 한다 (domain/plans.ts).
  if (typeof r.teamSeats === "number" && Number.isFinite(r.teamSeats) && r.teamSeats > 0) {
    limits.teamSeats = r.teamSeats;
  }
  return limits;
}

function asStatus(v: string): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(v) ? (v as SubscriptionStatus) : "canceled";
}

/** P-140: 공개 요금제 목록. 가격은 시장검증 전이므로 레코드에 없고(기획서 §9) 한도만 있다. */
export async function listPlans(): Promise<PlanRecord[]> {
  const rows = await q<PlanRow>(`SELECT code, name, limits FROM plans WHERE active = true ORDER BY code`);
  return rows.map((r) => ({ code: r.code, name: r.name, limits: toPlanLimits(r.limits) }));
}

/**
 * P-142: 내 구독. **소유자 스코프(`user_id = ctx.userId`)가 WHERE 에 있다** — 구독 id 를 안다고 남의 구독을
 * 읽을 수 있으면 안 된다(IDOR 차단, 보안정책 §2).
 *
 * 정렬은 "해지되지 않은 것 먼저, 그다음 최신" 이다. 과거 구독 행은 이력으로 남기므로(P-142)
 * 단순 최신 정렬로는 해지 이력이 활성 구독을 가릴 수 있다.
 */
export async function mySubscription(ctx: Ctx): Promise<SubscriptionRecord | null> {
  if (!ctx.userId) throw unauthorized();
  const row = await one<SubscriptionRow>(
    `SELECT id::text AS id, plan_code, status, started_at, ended_at
       FROM subscriptions
      WHERE user_id = $1
      ORDER BY (status <> 'canceled') DESC, started_at DESC
      LIMIT 1`,
    [ctx.userId],
  );
  if (!row) return null;
  return {
    id: row.id,
    planCode: row.plan_code,
    status: asStatus(row.status),
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  };
}

/**
 * P-141: 지금 적용되는 한도. 다른 모듈(`catalog`, `analytics`)이 생성·조회 전에 이 함수에 묻는다.
 *
 * 상태별 처리:
 * - 구독 없음 / `canceled` → 기본 요금제(free). 해지하면 유료 한도가 사라진다.
 * - `past_due` → **유료 한도를 유지한다.** 결제 실패 즉시 공개를 끊으면 카드 만료 하루가 신뢰 자산을 내리는
 *   결과가 되고, 재시도·유예 기간 요건은 PG 연동과 함께 확정된다 (미결정 §2). 유예를 끊는 기준은
 *   요건 확정 후 이 분기에 들어온다.
 */
export async function planLimitsFor(ctx: Ctx): Promise<EffectivePlan> {
  const sub = await mySubscription(ctx);
  const entitled = sub && sub.status !== "canceled" ? sub : null;
  const code = entitled?.planCode ?? DEFAULT_PLAN_CODE;

  const plan = await one<PlanRow>(`SELECT code, name, limits FROM plans WHERE code = $1`, [code]);
  if (!plan) {
    // 요금제 레코드가 사라졌다. 무제한으로 열지 않고 보수적 한도로 내려간다 (fail-closed).
    return {
      planCode: code,
      planName: code,
      limits: { ...CONSERVATIVE_LIMITS },
      subscriptionStatus: sub?.status ?? null,
      source: entitled ? "subscription" : "default",
    };
  }
  return {
    planCode: plan.code,
    planName: plan.name,
    limits: toPlanLimits(plan.limits),
    subscriptionStatus: sub?.status ?? null,
    source: entitled ? "subscription" : "default",
  };
}

/**
 * P-142: 구독 상태를 기록한다. **내부·관리자용이다.**
 *
 * 왜 관리자 능력을 요구하는가: 결제가 없는 상태에서 누구나 자기 요금제를 올릴 수 있으면 한도가 장식이 된다.
 * 지금은 `admin.access` 로 막는다 — ACL 에 `billing.manage` 능력이 없고 `domain/acl.ts` 는 이 작업의 담당 파일이
 * 아니기 때문이다. TODO(P-144): 결제 요건 확정 시 `billing.manage` 능력 추가 + 대상 사용자 인자 추가.
 *
 * TODO(P-144 / 미결정 §2): PG 연동 자리. 외부 결제 webhook 이 들어오면
 *   (1) 서명 검증 → (2) `idempotency_keys` 로 중복 처리 차단 → (3) 이 함수로 상태 반영 순서가 된다.
 *   결제·정산·환불 요건이 확정되기 전에는 이 모듈에서 외부 호출을 하지 않는다 (전략 §8).
 *
 * outbox 이벤트를 넣지 않는 이유: 이벤트 카탈로그(기술백서 §7 / `PROPLUS_EVENTS`)에 구독 이벤트가 없다.
 * 카탈로그 밖 이름은 `buildEnvelope()` 가 거부하고, 추가는 소비자와 함께 고치는 별도 PR 이어야 한다.
 */
export async function setSubscription(
  ctx: Ctx,
  planCode: string,
  status: SubscriptionStatus = "active",
): Promise<SubscriptionRecord> {
  const p = await principalOf(ctx);
  if (!can(p, "admin.access")) throw forbidden();
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
    throw badRequest("invalid_status", "구독 상태는 active|past_due|canceled 중 하나여야 합니다.");
  }
  const plan = await one<{ code: string }>(`SELECT code FROM plans WHERE code = $1 AND active = true`, [planCode]);
  if (!plan) throw notFound("plan");

  const userId = ctx.userId;
  if (!userId) throw unauthorized();

  const saved = await tx(async (c) => {
    // `subscriptions_active_user` 부분 유니크 인덱스(status <> 'canceled') 때문에 활성 행은 하나뿐이다.
    // 그래서 "있으면 갱신, 없으면 삽입" 이고, 해지 이력 행은 그대로 남는다 (P-142 변경 이력 보존).
    const updated = await c.query<SubscriptionRow>(
      `UPDATE subscriptions
          SET plan_code = $2,
              status    = $3,
              ended_at  = CASE WHEN $3 = 'canceled' THEN now() ELSE NULL END
        WHERE user_id = $1 AND status <> 'canceled'
        RETURNING id::text AS id, plan_code, status, started_at, ended_at`,
      [userId, planCode, status],
    );
    const row =
      updated.rows[0] ??
      (
        await c.query<SubscriptionRow>(
          `INSERT INTO subscriptions (user_id, plan_code, status, ended_at)
           VALUES ($1,$2,$3, CASE WHEN $3 = 'canceled' THEN now() ELSE NULL END)
           RETURNING id::text AS id, plan_code, status, started_at, ended_at`,
          [userId, planCode, status],
        )
      ).rows[0];
    if (!row) throw conflict("subscription_write_failed");

    // 운영자 행위이므로 접근 사유와 함께 남긴다 (P-165 / 보안정책 §3).
    await writeAudit(c, {
      eventType: "subscription.changed",
      actorId: ctx.userId,
      actorRole: p.platformRole,
      aggregateType: "subscription",
      aggregateId: row.id,
      payload: { planCode, status },
      accessPurpose: "billing_admin",
      correlationId: ctx.requestId,
    });
    return row;
  });

  return {
    id: saved.id,
    planCode: saved.plan_code,
    status: asStatus(saved.status),
    startedAt: saved.started_at.toISOString(),
    endedAt: saved.ended_at ? saved.ended_at.toISOString() : null,
  };
}

export interface CancelResult {
  subscriptionId: string;
  planCode: string;
  canceledAt: string;
  /** P-143: 해지 효과를 호출부가 추측하지 않게 정책을 함께 돌려준다. */
  afterCancel: typeof POST_CANCEL_POLICY;
}

/**
 * P-143: 본인 구독 해지. 소유자 스코프(`user_id = ctx.userId`)로만 동작한다.
 *
 * 해지는 **공개를 즉시 내리지 않는다.** 공개 여부는 `profiles.published_at` 이 소유하고 이 모듈은
 * 다른 모듈의 테이블을 쓰지 않는다 (CLAUDE.md §3). 대신 `POST_CANCEL_POLICY` 를 반환해
 * 화면이 "공개가 중단되고, 내보내기는 가능하다"를 같은 문구로 말하게 한다.
 * TODO: 공개 중단 자동화는 구독 이벤트(이벤트 카탈로그 추가 필요)를 M02 가 소비하는 형태가 되어야 한다.
 */
export async function cancel(ctx: Ctx): Promise<CancelResult> {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;

  const row = await tx(async (c) => {
    const r = await c.query<{ id: string; plan_code: string; ended_at: Date | null }>(
      `UPDATE subscriptions
          SET status = 'canceled', ended_at = now()
        WHERE user_id = $1 AND status <> 'canceled'
        RETURNING id::text AS id, plan_code, ended_at`,
      [userId],
    );
    const hit = r.rows[0];
    if (!hit) throw conflict("no_active_subscription", "해지할 활성 구독이 없습니다.");

    await writeAudit(c, {
      eventType: "subscription.canceled",
      actorId: userId,
      aggregateType: "subscription",
      aggregateId: hit.id,
      payload: { planCode: hit.plan_code },
      correlationId: ctx.requestId,
    });
    return hit;
  });

  return {
    subscriptionId: row.id,
    planCode: row.plan_code,
    canceledAt: (row.ended_at ?? new Date()).toISOString(),
    afterCancel: POST_CANCEL_POLICY,
  };
}
