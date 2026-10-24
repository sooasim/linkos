/**
 * M06 Catalog & Offer — P-090 상품 카드 · P-091 가격 표시 정책 · P-092 품절·만료 비공개 ·
 * P-093 외부 링크형 상품 · P-094 상품 CTA → 리드 · P-095 판매 권한 표시 · P-096 결제 연계(미결정).
 *
 * 출처: 모듈명세 M06("판매 권한과 상품 소유자를 표시하고, 품절/만료 상품이 공개되지 않도록 한다")
 *       + ADR-006(Medusa 실사 전 폴백 = 외부 링크형 상품 카드).
 *
 * 설계 의도 세 가지:
 *
 * 1. **공개 조회는 `public_offer_view` 만 읽는다** (N-4 / ADR-002). 품절·만료 판정은 그 뷰가
 *    읽기 시점에 한다(P-092) — 배치가 늦어서 품절 상품이 노출되는 창이 없어야 한다.
 *    뷰에서 읽은 뒤에도 `pickPublic(..., PUBLIC_OFFER_FIELDS)` 로 **재구성**한다. 뷰가 한 번,
 *    allowlist 가 한 번 거르므로 둘 중 하나가 틀려도 비공개 필드가 나가지 않는다.
 * 2. **요금제 한도는 노출 공간만 제한한다** (N-2 / P-141). `createOffer` 가 `withinLimit(limits,'offers',...)`
 *    를 묻는 것은 "상품 카드를 몇 개까지 두는가" 뿐이고, 배지·검증과는 아무 관계가 없다.
 *    이 모듈은 `proof` 를 import 하지 않으며, 한도 초과는 배지에 어떤 영향도 주지 않는다.
 * 3. **판매 권한(P-095)에 점수를 만들지 않는다.** 증거가 없으면 "판매 권한 미확인"으로 **표기**할 뿐이다.
 *    표기는 M04 의 배지 데이터를 공개 뷰에서 읽어 화면이 그린다 — 여기서 신뢰도를 계산하지 않는다(N-3).
 */

import {
  PUBLIC_OFFER_FIELDS,
  assertNoPrivateKeys,
  can,
  pickPublic,
  sanitizeText,
  stripDangerousUrl,
  withinLimit,
} from "@proplus/domain";
import type { MemberRole, PlatformRole, Principal } from "@proplus/domain";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { enqueue } from "../lib/outbox";
import { planLimitsFor } from "./billing";

/** DB `price_policy` enum 과 1:1 (0001_proplus_core.sql). */
export const PRICE_POLICIES = ["shown", "inquiry", "hidden"] as const;
export type PricePolicy = (typeof PRICE_POLICIES)[number];

/** DB `offers.status` CHECK 와 1:1. */
export const OFFER_STATUSES = ["draft", "active", "sold_out", "archived"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_OWNER_TYPES = ["profile", "organization"] as const;
export type OfferOwnerType = (typeof OFFER_OWNER_TYPES)[number];

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const CURRENCY_RE = /^[A-Z]{3}$/;

export interface OfferInput {
  title: string;
  description?: string | null;
  priceDisplayPolicy?: PricePolicy;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  externalUrl?: string | null;
  availableUntil?: string | Date | null;
  /** P-089: 조직 공용 카탈로그. 기본값은 개인(profile) 소유다. */
  ownerType?: OfferOwnerType;
  organizationId?: string | null;
}

export interface Offer {
  id: string;
  ownerType: OfferOwnerType;
  ownerId: string;
  profileId: string | null;
  title: string;
  description: string | null;
  priceDisplayPolicy: PricePolicy;
  priceAmount: number | null;
  priceCurrency: string | null;
  externalUrl: string | null;
  status: OfferStatus;
  availableUntil: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface PublicOffer {
  id: string;
  title: string;
  description: string | null;
  priceDisplayPolicy: PricePolicy;
  priceAmount: number | null;
  priceCurrency: string | null;
  externalUrl: string | null;
  ownerType: OfferOwnerType;
}

type OfferRow = {
  id: string;
  owner_type: string;
  owner_id: string;
  profile_id: string | null;
  title: string;
  description: string | null;
  price_display_policy: string;
  price_amount: string | null;
  price_currency: string | null;
  external_url: string | null;
  status: string;
  available_until: Date | null;
  published_at: Date | null;
  created_at: Date;
};
type PublicOfferRow = {
  id: string;
  title: string;
  description: string | null;
  price_display_policy: string;
  price_amount: string | null;
  price_currency: string | null;
  external_url: string | null;
  owner_type: string;
};
type UserRow = { platform_role: PlatformRole };
type MembershipRow = { organization_id: string; role: MemberRole; status: string };
type ProfileRow = { id: string; user_id: string };

/** 모듈이 권한을 계산하지 않고 `can()` 에 묻기 위한 재료를 모은다 (CLAUDE.md §3). */
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
 * 내 프로필. 상품은 프로필에 걸려 있으므로(`offers.profile_id`) 모든 쓰기의 소유자 스코프가 여기서 나온다.
 * ACL 에 상품 전용 능력이 없어 `profile.edit` 를 쓴다 — 상품 카드는 미니사이트의 일부이고,
 * 조직 관리자가 남의 개인 프로필 상품을 고칠 수 있으면 N-12 가 깨진다.
 */
async function myProfile(ctx: Ctx): Promise<ProfileRow> {
  if (!ctx.userId) throw unauthorized();
  const row = await one<ProfileRow>(`SELECT id::text AS id, user_id::text AS user_id FROM profiles WHERE user_id = $1`, [
    ctx.userId,
  ]);
  if (!row) throw notFound("profile");
  return row;
}

function assertOfferOwner(p: Principal, profile: ProfileRow): void {
  if (!can(p, "profile.edit", { ownerUserId: profile.user_id })) throw forbidden();
}

function toOffer(r: OfferRow): Offer {
  return {
    id: r.id,
    ownerType: (OFFER_OWNER_TYPES as readonly string[]).includes(r.owner_type)
      ? (r.owner_type as OfferOwnerType)
      : "profile",
    ownerId: r.owner_id,
    profileId: r.profile_id,
    title: r.title,
    description: r.description,
    priceDisplayPolicy: (PRICE_POLICIES as readonly string[]).includes(r.price_display_policy)
      ? (r.price_display_policy as PricePolicy)
      : "inquiry",
    // numeric 은 node-pg 가 문자열로 준다(정밀도 보존). 응답에서는 숫자로 쓰므로 여기서 한 번만 변환한다.
    priceAmount: r.price_amount === null ? null : Number(r.price_amount),
    priceCurrency: r.price_currency,
    externalUrl: r.external_url,
    status: (OFFER_STATUSES as readonly string[]).includes(r.status) ? (r.status as OfferStatus) : "draft",
    availableUntil: r.available_until ? r.available_until.toISOString() : null,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * P-091: 가격은 **표시 정책이 'shown' 일 때만 저장한다.**
 *
 * 왜 null 로 지우는가: 정책을 '문의'로 바꿨는데 금액이 행에 남아 있으면, 나중에 누가 뷰·DTO 를 고치는
 * 순간 "숨겼다고 믿었던 가격"이 흘러나간다. 공개 뷰가 CASE 로 가려 주지만(0001 `public_offer_view`)
 * 저장 단계에서도 지워 두는 것이 N-4 의 기본 태도(공개될 길을 만들지 않는다)에 맞는다.
 */
function normalizePrice(input: {
  policy: PricePolicy;
  amount?: number | null;
  currency?: string | null;
}): { amount: number | null; currency: string | null } {
  if (input.policy !== "shown") return { amount: null, currency: null };

  const amount = input.amount;
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || !currency || !CURRENCY_RE.test(currency)) {
    // DB CHECK `offer_shown_price_complete` 와 같은 판정을 먼저 한다. 같은 실패가 두 경로에서 같은 코드로 나가야 한다.
    throw badRequest("price_incomplete", "가격을 표시하려면 금액과 통화(ISO 4217)가 필요합니다.");
  }
  return { amount, currency };
}

/**
 * DB 제약 위반을 입력 오류로 바꾼다 (P-187: 내부 오류와 입력 오류를 구분한다).
 * 애플리케이션 검사를 먼저 하지만, 동시 요청·직접 SQL 경로에서도 같은 코드로 응답해야 한다.
 */
function mapOfferDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string };
  if (err?.code === "23514" && err.constraint === "offer_shown_price_complete") {
    return badRequest("price_incomplete", "가격을 표시하려면 금액과 통화가 필요합니다.");
  }
  if (err?.code === "23514") return badRequest("invalid_offer", "상품 값이 제약을 만족하지 않습니다.");
  if (err?.code === "23503") return notFound("offer_owner");
  return e;
}

function parseAvailableUntil(v: string | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid_date", "available_until 을 해석할 수 없습니다.");
  return d;
}

/** P-093: 외부 링크는 http/https 만. `javascript:`·`data:` 는 도메인 함수가 null 로 돌려준다. */
function normalizeExternalUrl(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const safe = stripDangerousUrl(v);
  if (!safe) throw badRequest("invalid_url", "외부 링크는 http/https 주소만 쓸 수 있습니다.");
  return safe;
}

/** P-090: 내 상품 목록(초안·보관 포함). 소유자 스코프가 WHERE 에 있다 — IDOR 차단. */
export async function listMyOffers(ctx: Ctx): Promise<Offer[]> {
  const p = await principalOf(ctx);
  const profile = await myProfile(ctx);
  assertOfferOwner(p, profile);

  const rows = await q<OfferRow>(
    `SELECT o.id::text AS id, o.owner_type::text AS owner_type, o.owner_id::text AS owner_id,
            o.profile_id::text AS profile_id, o.title, o.description,
            o.price_display_policy::text AS price_display_policy, o.price_amount, o.price_currency,
            o.external_url, o.status, o.available_until, o.published_at, o.created_at
       FROM offers o
      WHERE o.profile_id = $1
      ORDER BY o.created_at DESC
      LIMIT 500`,
    [profile.id],
  );
  return rows.map(toOffer);
}

/**
 * P-090/P-141: 상품 카드 생성. 항상 `draft` 로 만든다 — 공개는 `setOfferStatus(..., 'active')` 라는
 * 별도 행위여야 한다(실수로 반쯤 쓴 카드가 공개되지 않게).
 *
 * 한도 초과는 `conflict('plan_limit')` 이다. **이 한도는 배지와 아무 관계가 없다** (N-2):
 * 요금제는 상품 카드 **개수**만 제한하고, 검증·배지 발급 경로는 구독을 인자로도 받지 않는다.
 */
export async function createOffer(ctx: Ctx, input: OfferInput): Promise<Offer> {
  const p = await principalOf(ctx);
  const profile = await myProfile(ctx);
  assertOfferOwner(p, profile);

  const title = sanitizeText(input.title ?? "", TITLE_MAX);
  if (title.length < 2) throw badRequest("invalid_title", "상품명을 2자 이상 입력하세요.");
  const description = input.description ? sanitizeText(input.description, DESCRIPTION_MAX) : null;

  const policy: PricePolicy = input.priceDisplayPolicy ?? "inquiry";
  if (!(PRICE_POLICIES as readonly string[]).includes(policy)) {
    throw badRequest("invalid_price_policy", "가격 표시 정책은 shown|inquiry|hidden 중 하나입니다.");
  }
  const price = normalizePrice({ policy, amount: input.priceAmount, currency: input.priceCurrency });
  const externalUrl = normalizeExternalUrl(input.externalUrl);
  const availableUntil = parseAvailableUntil(input.availableUntil);

  const ownerType: OfferOwnerType = input.ownerType ?? "profile";
  if (!(OFFER_OWNER_TYPES as readonly string[]).includes(ownerType)) {
    throw badRequest("invalid_owner_type", "상품 소유자는 profile|organization 입니다.");
  }
  let ownerId = profile.id;
  if (ownerType === "organization") {
    const organizationId = input.organizationId ?? null;
    // P-089: 조직 소유 상품은 그 조직의 관리자만 만든다. 조직 소유라도 프로필 소유권은 생기지 않는다 (N-12).
    if (!organizationId || !can(p, "org.manage", { organizationId })) throw forbidden();
    ownerId = organizationId;
  }

  // P-141: 요금제 한도는 "노출 공간"만 본다. archived 는 공개되지 않으므로 세지 않는다.
  const plan = await planLimitsFor(ctx);
  const countRow = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM offers WHERE profile_id = $1 AND status <> 'archived'`,
    [profile.id],
  );
  const current = countRow?.n ?? 0;
  if (!withinLimit(plan.limits, "offers", current)) {
    throw conflict("plan_limit", "요금제의 상품 카드 한도를 초과했습니다.", {
      planCode: plan.planCode,
      limit: plan.limits.offers,
      current,
    });
  }

  try {
    const row = await one<OfferRow>(
      `INSERT INTO offers
         (owner_type, owner_id, profile_id, title, description,
          price_display_policy, price_amount, price_currency, external_url, status, available_until)
       VALUES ($1::offer_owner, $2, $3, $4, $5, $6::price_policy, $7, $8, $9, 'draft', $10)
       RETURNING id::text AS id, owner_type::text AS owner_type, owner_id::text AS owner_id,
                 profile_id::text AS profile_id, title, description,
                 price_display_policy::text AS price_display_policy, price_amount, price_currency,
                 external_url, status, available_until, published_at, created_at`,
      [
        ownerType,
        ownerId,
        profile.id,
        title,
        description,
        policy,
        price.amount,
        price.currency,
        externalUrl,
        availableUntil,
      ],
    );
    if (!row) throw conflict("offer_write_failed");
    return toOffer(row);
  } catch (e) {
    throw mapOfferDbError(e);
  }
}

/**
 * P-090~P-093 수정. 공개 카탈로그가 바뀌는 쓰기이므로 **같은 트랜잭션에서** `product.updated` 를
 * outbox 에 적는다 (P-183: 쓰기와 이벤트가 갈라지면 외부 연동이 옛 가격을 계속 안다).
 */
export async function updateOffer(ctx: Ctx, id: string, input: OfferInput): Promise<Offer> {
  const p = await principalOf(ctx);
  const profile = await myProfile(ctx);
  assertOfferOwner(p, profile);

  const existing = await one<OfferRow>(
    `SELECT o.id::text AS id, o.owner_type::text AS owner_type, o.owner_id::text AS owner_id,
            o.profile_id::text AS profile_id, o.title, o.description,
            o.price_display_policy::text AS price_display_policy, o.price_amount, o.price_currency,
            o.external_url, o.status, o.available_until, o.published_at, o.created_at
       FROM offers o
      WHERE o.id = $1 AND o.profile_id = $2`,
    [id, profile.id],
  );
  if (!existing) throw notFound("offer");
  const before = toOffer(existing);

  const title = input.title === undefined ? before.title : sanitizeText(input.title, TITLE_MAX);
  if (title.length < 2) throw badRequest("invalid_title", "상품명을 2자 이상 입력하세요.");
  const description =
    input.description === undefined
      ? before.description
      : input.description
        ? sanitizeText(input.description, DESCRIPTION_MAX)
        : null;

  const policy: PricePolicy = input.priceDisplayPolicy ?? before.priceDisplayPolicy;
  if (!(PRICE_POLICIES as readonly string[]).includes(policy)) {
    throw badRequest("invalid_price_policy", "가격 표시 정책은 shown|inquiry|hidden 중 하나입니다.");
  }
  const price = normalizePrice({
    policy,
    amount: input.priceAmount === undefined ? before.priceAmount : input.priceAmount,
    currency: input.priceCurrency === undefined ? before.priceCurrency : input.priceCurrency,
  });
  const externalUrl = input.externalUrl === undefined ? before.externalUrl : normalizeExternalUrl(input.externalUrl);
  const availableUntil =
    input.availableUntil === undefined
      ? before.availableUntil
        ? new Date(before.availableUntil)
        : null
      : parseAvailableUntil(input.availableUntil);

  try {
    return await tx(async (c) => {
      const r = await c.query<OfferRow>(
        `UPDATE offers
            SET title = $3, description = $4, price_display_policy = $5::price_policy,
                price_amount = $6, price_currency = $7, external_url = $8, available_until = $9
          WHERE id = $1 AND profile_id = $2
          RETURNING id::text AS id, owner_type::text AS owner_type, owner_id::text AS owner_id,
                    profile_id::text AS profile_id, title, description,
                    price_display_policy::text AS price_display_policy, price_amount, price_currency,
                    external_url, status, available_until, published_at, created_at`,
        [id, profile.id, title, description, policy, price.amount, price.currency, externalUrl, availableUntil],
      );
      const row = r.rows[0];
      if (!row) throw notFound("offer");

      // payload 는 식별자와 코드만 — 상품명·설명은 담지 않는다 (N-13 / 기술백서 §7).
      await enqueue(c, {
        eventType: "product.updated",
        aggregateType: "offer",
        aggregateId: row.id,
        tenantId: row.owner_type === "organization" ? row.owner_id : null,
        actorId: ctx.userId,
        correlationId: ctx.requestId,
        payload: { profileId: row.profile_id, status: row.status, priceDisplayPolicy: policy },
      });
      return toOffer(row);
    });
  } catch (e) {
    throw mapOfferDbError(e);
  }
}

/**
 * 상품 삭제. 공개 목록이 바뀌므로 삭제도 `product.updated` 로 알린다 —
 * 이벤트 카탈로그(기술백서 §7)에 `product.deleted` 가 없고, 카탈로그 밖 이름은 `buildEnvelope()` 가 거부한다.
 * payload 의 `deleted: true` 로 구분한다.
 */
export async function deleteOffer(ctx: Ctx, id: string): Promise<{ deleted: boolean }> {
  const p = await principalOf(ctx);
  const profile = await myProfile(ctx);
  assertOfferOwner(p, profile);

  return tx(async (c) => {
    const r = await c.query<{ id: string; owner_type: string; owner_id: string }>(
      `DELETE FROM offers WHERE id = $1 AND profile_id = $2
       RETURNING id::text AS id, owner_type::text AS owner_type, owner_id::text AS owner_id`,
      [id, profile.id],
    );
    const row = r.rows[0];
    if (!row) throw notFound("offer");

    await enqueue(c, {
      eventType: "product.updated",
      aggregateType: "offer",
      aggregateId: row.id,
      tenantId: row.owner_type === "organization" ? row.owner_id : null,
      actorId: ctx.userId,
      correlationId: ctx.requestId,
      payload: { profileId: profile.id, deleted: true },
    });
    return { deleted: true };
  });
}

/**
 * P-092: 공개 상품 목록. **`public_offer_view` 만 읽는다** — 품절·만료·미발행 판정이 그 뷰 안에 있다.
 * 프로필도 `public_profile_view` 로 join 해서, 비공개 프로필의 상품이 slug 만으로 보이지 않게 한다.
 *
 * 인증이 필요 없는 경로이므로 `Ctx` 를 받지 않는다 (게스트 랜딩은 로그인 벽 없이 떠야 한다).
 */
export async function publicOffers(slug: string): Promise<PublicOffer[]> {
  if (typeof slug !== "string" || slug.trim() === "") throw badRequest("invalid_slug");

  const rows = await q<PublicOfferRow>(
    `SELECT o.id::text AS id, o.title, o.description,
            o.price_display_policy::text AS price_display_policy,
            o.price_amount, o.price_currency, o.external_url, o.owner_type::text AS owner_type
       FROM public_offer_view o
       JOIN public_profile_view v ON v.id = o.profile_id
      WHERE v.slug = $1
      ORDER BY o.title
      LIMIT 200`,
    [slug],
  );

  const out = rows.map((r) => {
    const dto: PublicOffer = {
      id: r.id,
      title: r.title,
      description: r.description,
      priceDisplayPolicy: (PRICE_POLICIES as readonly string[]).includes(r.price_display_policy)
        ? (r.price_display_policy as PricePolicy)
        : "inquiry",
      priceAmount: r.price_amount === null ? null : Number(r.price_amount),
      priceCurrency: r.price_currency,
      externalUrl: r.external_url,
      ownerType: (OFFER_OWNER_TYPES as readonly string[]).includes(r.owner_type)
        ? (r.owner_type as OfferOwnerType)
        : "profile",
    };
    // N-4: 뷰에서 읽은 행을 그대로 쓰지 않고 allowlist 로 재구성한다. 뷰에 컬럼이 추가돼도 응답은 그대로다.
    return pickPublic(dto, PUBLIC_OFFER_FIELDS) as PublicOffer;
  });

  // 트립와이어. 공개 프로필은 핫패스(P-194)이므로 운영에서는 돌리지 않는다 (publicDto.ts 주석).
  if (process.env.NODE_ENV !== "production") assertNoPrivateKeys(out);
  return out;
}

/**
 * P-090/P-092: 상태 전환. `active` 로 올릴 때 `published_at` 을 채운다 — `public_offer_view` 가
 * `status='active' AND published_at IS NOT NULL` 을 요구하므로, 이 한 줄이 "공개"의 정의다.
 *
 * 품절(`sold_out`)·보관(`archived`)은 공개에서 즉시 빠진다(뷰 조건). 상태를 되돌리는 것도 허용한다 —
 * 재입고가 흔한 운영 현실이고, 되돌림을 막으면 사용자가 카드를 새로 만들어 이력이 끊긴다.
 */
export async function setOfferStatus(ctx: Ctx, id: string, status: OfferStatus): Promise<Offer> {
  const p = await principalOf(ctx);
  const profile = await myProfile(ctx);
  assertOfferOwner(p, profile);

  if (!(OFFER_STATUSES as readonly string[]).includes(status)) {
    throw badRequest("invalid_status", "상품 상태는 draft|active|sold_out|archived 중 하나입니다.");
  }

  try {
    return await tx(async (c) => {
      const r = await c.query<OfferRow>(
        `UPDATE offers
            SET status = $3,
                published_at = CASE WHEN $3 = 'active' AND published_at IS NULL THEN now() ELSE published_at END
          WHERE id = $1 AND profile_id = $2
          RETURNING id::text AS id, owner_type::text AS owner_type, owner_id::text AS owner_id,
                    profile_id::text AS profile_id, title, description,
                    price_display_policy::text AS price_display_policy, price_amount, price_currency,
                    external_url, status, available_until, published_at, created_at`,
        [id, profile.id, status],
      );
      const row = r.rows[0];
      if (!row) throw notFound("offer");

      await enqueue(c, {
        eventType: "product.updated",
        aggregateType: "offer",
        aggregateId: row.id,
        tenantId: row.owner_type === "organization" ? row.owner_id : null,
        actorId: ctx.userId,
        correlationId: ctx.requestId,
        payload: { profileId: row.profile_id, status },
      });
      return toOffer(row);
    });
  } catch (e) {
    throw mapOfferDbError(e);
  }
}

// TODO(P-096 / 미결정 §2): 결제·주문 연계. 결제·정산·환불 요건이 확정되기 전에는 주문 테이블을 만들지 않는다.
//   지금의 폴백은 ADR-006 이 정한 "외부 링크형 상품 카드"다 — 결제는 판매자의 외부 채널에서 일어나고,
//   플랫폼은 어디로 가는 링크인지만 안전하게(P-093) 보여 준다.
// TODO(P-094): 상품에서 시작한 상담은 `leads.offer_id` 로 기록된다 — 그 쓰기는 M07(`modules/lead.ts`)의 것이고
//   이 모듈은 상품 쪽에서 그 참조를 만들지 않는다 (모듈은 자기 테이블에만 쓴다).
