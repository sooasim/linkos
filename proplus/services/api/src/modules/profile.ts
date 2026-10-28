/**
 * M02 Profile & Personal Brand + M03 Mini-site — P-020~P-036, P-040~P-048.
 *
 * 출처: dd/PROPLUS_Technical_Document_Set/02_모듈명세_제품요구사항.md M02·M03
 *       + 01_기술백서_시스템아키텍처.md §6 공개 DTO allowlist
 *       + 03_데이터모델_API명세.md §3 공개/비공개 경계
 *       스키마: proplus/db/migrations/0001_proplus_core.sql §M02 + 공개 뷰 4개
 *
 * 이 모듈의 핵심은 **공개 경로와 소유자 경로가 서로 다른 데이터 출처를 쓴다는 것**이다:
 *
 *   공개(`getPublicProfile`)  → `public_profile_view` / `public_badge_view` / `public_metric_view` / `public_offer_view`
 *   소유자(`getMyProfile` 등) → `profiles` / `profile_*` 원본 (언제나 `user_id` 조건이 붙는다)
 *
 * 공개 경로가 원본 테이블을 읽지 않는 이유(N-4 / ADR-002): 뷰에 없는 컬럼은 공개될 길이 자체가 없다.
 * 나중에 `profiles` 에 `internal_note` 가 추가돼도 공개 응답은 영향을 받지 않는다. 그 성질을 지키려면
 * "allowlist 를 잘 적는 것"만으로는 부족하고 **읽는 곳이 뷰여야** 한다.
 */

import {
  PUBLIC_METRIC_FIELDS,
  PUBLIC_OFFER_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  RESERVED_SLUGS,
  type BadgeRow,
  type Block,
  type Capability,
  type Principal,
  type PublicBadge,
  type VerificationMethod,
  assertNoPrivateKeys,
  buildVCard,
  can,
  findForbiddenClaim,
  normalizeSlug,
  pickPublic,
  profileCompleteness,
  publicContact,
  sanitizeText,
  toPublicBadges,
  validateBlocks,
  validateSlug,
} from "@proplus/domain";
import { writeAudit } from "../lib/audit";
import { consumeLimit } from "../lib/limits";
import type { Ctx } from "../lib/ctx";
import { one, q, tx } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "../lib/errors";
import { enqueue } from "../lib/outbox";
import { principalFor } from "./identity";
import type { PoolClient } from "pg";

/** 길이 상한. 공개 프로필의 타이포 스케일(브랜드 §7)과 SSR 렌더 비용을 같이 지키는 선이다. */
const DISPLAY_NAME_MAX = 80;
const HEADLINE_MAX = 120;
const BIO_MAX = 2000;
const REGION_MAX = 60;

/** P-022: 자유 입력 전문분야는 개수를 제한한다. 제한이 없으면 키워드 스터핑이 검색 품질을 먹는다. */
const SPECIALTY_MAX_ITEMS = 12;
const SPECIALTY_ITEM_MAX = 60;
const LANGUAGE_MAX_ITEMS = 10;
const LANGUAGE_ITEM_MAX = 40;

/** P-023: `profile_facts.kind` CHECK 와 같은 목록. 어긋나면 23514 로 터지므로 여기서 먼저 거른다. */
const FACT_KINDS: readonly string[] = ["career", "education", "certification", "skill", "award"];
const FACT_LABEL_MAX = 120;
const FACT_DETAIL_MAX = 1000;
const FACTS_PER_CALL_MAX = 50;

/**
 * P-029: 공개 설정 allowlist. 이 표에 없는 키는 **저장되지 않는다**.
 *
 * 연락처 공개(`showEmail`/`showPhone`)의 기본값이 꺼짐인 것이 규칙 자체다 (기술백서 §6:
 * 전화·이메일은 별도 공개 동의 없이는 숨긴다). 이 플래그를 켜는 행위가 그 "별도 동의"이고,
 * 그래서 변경은 감사로그에 남는다.
 */
const SETTINGS_BOOL_KEYS: readonly string[] = ["showRegion", "showEmail", "showPhone"];
const SETTINGS_TEXT_KEYS: Readonly<Record<string, number>> = { ctaLabel: 40, ctaNote: 300 };

// TODO(P-044/P-045): 템플릿·색상 토큰 키는 여기 넣지 않는다. 승인된 템플릿 목록이 문서에 없고
// (브랜드 §7 은 "템플릿이 배지 표기 규칙을 바꾸지 못한다"는 제약만 정한다), 목록을 임의로 정하면
// 그게 사실상 제품 결정이 된다 (CLAUDE.md §7 "문서가 미결정이라고 적은 것은 결정하지 않는다").

type ProfileRow = {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  languages: string[];
  region: string | null;
  public_settings: Record<string, unknown> | null;
  published_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export interface ProfileWriteInput {
  slug?: string;
  displayName?: string;
  headline?: string | null;
  bio?: string | null;
  specialties?: readonly string[];
  languages?: readonly string[];
  region?: string | null;
  publicSettings?: Record<string, unknown>;
}

export interface MyProfile {
  id: string;
  slug: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  languages: string[];
  region: string | null;
  publicSettings: Record<string, unknown>;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicMetric {
  metricCode: string;
  value: number;
  unit: string;
  periodStart: string | null;
  periodEnd: string | null;
  sampleSize: number;
  basis: string;
  verified: boolean;
}

export interface PublicOffer {
  id: string;
  title: string;
  description: string | null;
  priceDisplayPolicy: string;
  priceAmount: number | null;
  priceCurrency: string | null;
  externalUrl: string | null;
  ownerType: string;
}

export interface PublicBlockDto {
  kind: string;
  position: number;
  props: Record<string, unknown>;
}

/**
 * 공개 조회의 호출자 정보 (P-189).
 *
 * 왜 `Ctx` 를 받지 않는가: 공개 프로필은 비회원이 보는 화면이라 세션이 없고, `Ctx` 를 요구하면
 * 라우트가 의미 없는 빈 ctx 를 만들게 된다. 필요한 것은 **rate limit 버킷 재료**뿐이다.
 *
 * optional 인 이유: SSR 페이지·시드·테스트는 한도 없이 호출해야 한다. 라우트만 넘긴다.
 */
export interface PublicViewer {
  ip: string;
}

/**
 * P-189: 공개 프로필·vCard 조회에 거친 한도를 건다.
 *
 * 버킷을 `ip:slug` 가 아니라 **ip 단위**로 잡는다. slug 를 섞으면 프로필을 돌아가며 긁는
 * 스크래퍼가 버킷을 무한히 갈라 한도를 통째로 우회한다 (같은 실수를 `lead.create` 에서는
 * slug 를 섞어 저질렀고, 그래서 라우트가 slug 를 먼저 정규화해 막는다 — lead 라우트 주석 참조).
 */
async function limitPublicView(viewer: PublicViewer | undefined, _slug: string): Promise<void> {
  if (!viewer?.ip) return;
  await consumeLimit("public.view", viewer.ip);
}

export interface PublicProfileDto {
  slug: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  languages: string[];
  region: string | null;
  publishedAt: string | null;
  badges: PublicBadge[];
  metrics: PublicMetric[];
  offers: PublicOffer[];
  blocks: PublicBlockDto[];
  /**
   * P-023: 경력·학력·자격 항목. **provenance 를 들고 나간다** (기획서 §5-4 "명확한 출처").
   *
   * 검증된 항목(`method` 있음)과 자기기재 항목(`method: null`)을 **같은 목록에 섞어 내보내되
   * 구분은 필드로** 한다. 자기기재를 아예 숨기면 프로필이 비어 보이고, 구분 없이 섞으면
   * 확인된 것처럼 읽힌다 — 둘 다 틀렸다. 화면이 "자기기재" 라벨을 붙일 수 있게 하는 것이 목적이다.
   */
  facts: PublicFact[];
}

export interface PublicFact {
  kind: string;
  label: string;
  detail: string | null;
  startedOn: string | null;
  endedOn: string | null;
  /** 이 항목을 뒷받침하는 검증 강도. `null` 이면 자기기재이고 화면이 그렇게 표기해야 한다 (N-1). */
  method: VerificationMethod | null;
}

export interface FactInput {
  /** 있으면 수정, 없으면 추가. 수정은 소유자 조건이 걸린 UPDATE 라 남의 항목 id 로는 아무 일도 일어나지 않는다. */
  id?: string | null;
  kind: string;
  label: string;
  detail?: string | null;
  startedOn?: string | null;
  endedOn?: string | null;
  position?: number;
}

export interface ProfileFact {
  id: string;
  kind: string;
  label: string;
  detail: string | null;
  startedOn: string | null;
  endedOn: string | null;
  /** N-1: 검증 여부는 `verification_id` 의 존재로만 결정된다. 사용자가 쓸 수 있는 필드가 아니다. */
  verified: boolean;
  position: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────────────────────────────────────

function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw unauthorized();
  return ctx.userId;
}

/** 판정은 도메인이 하고(전략 §3) 에러 모양만 접는다 — `assertCan` 의 Error 를 그대로 올리면 500 이 된다. */
function requireCan(p: Principal, cap: Capability, target: { ownerUserId?: string; organizationId?: string } = {}): void {
  if (!can(p, cap, target)) throw forbidden();
}

/** 쓰기 권한 확인. N-12: 프로필은 본인만 고친다 — 조직 관리자도, 운영자도 경로가 없다. */
async function assertOwner(ctx: Ctx): Promise<string> {
  const userId = requireUser(ctx);
  const principal = await principalFor(userId);
  requireCan(principal, "profile.edit", { ownerUserId: userId });
  return userId;
}

function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? "https://proplus.linkos.com").replace(/\/+$/, "");
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `date` 컬럼을 YYYY-MM-DD 로 적는다.
 *
 * `toISOString()` 을 쓰지 않는 이유: pg 는 DATE 를 **로컬 자정** Date 로 만든다. KST(+09:00)에서
 * ISO 로 바꾸면 하루 전으로 밀린다 — 지표의 기간 표시(N-8)가 조용히 틀려지는 종류의 버그다.
 */
function dateOnly(v: Date | string | null): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** numeric 은 pg 가 문자열로 준다(정밀도 보존). 공개 DTO 에는 숫자로 내보낸다. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function requiredText(v: unknown, max: number, code: string, message: string): string {
  const s = typeof v === "string" ? sanitizeText(v, max) : "";
  if (s.length === 0) throw badRequest(code, message);
  return s;
}

function optionalText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = sanitizeText(v, max);
  return s.length > 0 ? s : null;
}

function textList(v: unknown, maxItems: number, itemMax: number, code: string): string[] {
  if (!Array.isArray(v)) throw badRequest(code, "목록 형식이 올바르지 않습니다.");
  const out: string[] = [];
  for (const raw of v) {
    if (out.length >= maxItems) break;
    if (typeof raw !== "string") continue;
    const s = sanitizeText(raw, itemMax);
    // 중복은 공개 화면에서 같은 칩이 두 번 보이는 것으로만 드러나므로 저장 전에 접는다.
    if (s.length > 0 && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 브랜드 §5: 근거 없는 최상급 표현은 저장 자체를 막는다. 공개 라벨은 검증에서만 나와야 한다. */
function assertNoForbiddenClaim(value: string | null, field: string): void {
  if (!value) return;
  const hit = findForbiddenClaim(value);
  if (hit) {
    throw badRequest("forbidden_claim", `근거를 확인할 수 없는 표현은 사용할 수 없습니다: "${hit}"`, { field, match: hit });
  }
}

function cleanSettings(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_BOOL_KEYS) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  for (const [key, max] of Object.entries(SETTINGS_TEXT_KEYS)) {
    const v = src[key];
    if (v === null) {
      out[key] = null;
      continue;
    }
    if (typeof v === "string") {
      const s = sanitizeText(v, max);
      out[key] = s.length > 0 ? s : null;
    }
  }
  return out;
}

function slugOrThrow(raw: string): string {
  const verdict = validateSlug(raw);
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);
  return verdict.slug;
}

/**
 * UNIQUE 위반을 사용자가 읽을 수 있는 코드로 바꾼다.
 *
 * `profiles_one_per_user` 는 **데이터모델 §7-1 미결정**("개인 계정의 복수 프로필 허용 여부")을
 * 인덱스로 묶어 둔 것이다. 정책이 정해지면 인덱스를 드롭하고 이 분기를 지운다 — 지금 임의로
 * 복수 프로필을 허용하는 쪽으로 구현하지 않는다 (전략 §8).
 */
function mapUniqueViolation(e: unknown): never {
  const code = (e as { code?: string }).code;
  const constraint = (e as { constraint?: string }).constraint ?? "";
  if (code === "23505") {
    if (constraint.includes("one_per_user")) {
      throw conflict("profile_exists", "이미 프로필이 있습니다. 기존 프로필을 수정하세요.");
    }
    if (constraint.includes("slug")) {
      throw conflict("slug_taken", "이미 사용 중인 주소입니다.");
    }
  }
  throw e;
}

function toMyProfile(r: ProfileRow): MyProfile {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    headline: r.headline,
    bio: r.bio,
    specialties: r.specialties ?? [],
    languages: r.languages ?? [],
    region: r.region,
    publicSettings: r.public_settings ?? {},
    publishedAt: iso(r.published_at),
    version: r.version,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

/** P-028: 버전 스냅샷에 담는 내용. 발행 상태(published_at)는 **담지 않는다** — 복원은 내용 복원이고 재발행이 아니다. */
function snapshotOf(r: ProfileRow): Record<string, unknown> {
  return {
    slug: r.slug,
    displayName: r.display_name,
    headline: r.headline,
    bio: r.bio,
    specialties: r.specialties ?? [],
    languages: r.languages ?? [],
    region: r.region,
    publicSettings: r.public_settings ?? {},
  };
}

async function lockedProfile(c: PoolClient, userId: string): Promise<ProfileRow> {
  // 동시 저장이 버전 번호를 같은 값으로 쓰는 것을 막는다(`profile_versions` UNIQUE(profile_id, version)).
  // 소유자 조건이 WHERE 에 있으므로 다른 사람의 프로필을 잠글 수도, 고칠 수도 없다.
  const row = await one<ProfileRow>(`SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE`, [userId], c);
  if (!row) throw notFound("profile");
  return row;
}

/**
 * 저장 한 번 = 버전 하나 (P-028). 내용 병합·sanitize·버전 증가·스냅샷을 한 자리에 모아 둔다 —
 * `updateProfile` 과 `restoreVersion` 이 서로 다른 파이프라인을 쓰면 복원 경로만 sanitize 를 빠뜨리게 된다.
 */
async function writeProfile(
  c: PoolClient,
  cur: ProfileRow,
  input: ProfileWriteInput,
  ctx: Ctx,
): Promise<ProfileRow> {
  const slug = input.slug !== undefined ? slugOrThrow(input.slug) : cur.slug;
  const displayName =
    input.displayName !== undefined
      ? requiredText(input.displayName, DISPLAY_NAME_MAX, "display_name_required", "이름을 입력하세요.")
      : cur.display_name;

  const headline = input.headline !== undefined ? optionalText(input.headline, HEADLINE_MAX) : cur.headline;
  const bio = input.bio !== undefined ? optionalText(input.bio, BIO_MAX) : cur.bio;
  const region = input.region !== undefined ? optionalText(input.region, REGION_MAX) : cur.region;

  const specialties =
    input.specialties !== undefined
      ? textList(input.specialties, SPECIALTY_MAX_ITEMS, SPECIALTY_ITEM_MAX, "invalid_specialties")
      : (cur.specialties ?? []);
  const languages =
    input.languages !== undefined
      ? textList(input.languages, LANGUAGE_MAX_ITEMS, LANGUAGE_ITEM_MAX, "invalid_languages")
      : (cur.languages ?? []);

  // 들어온 값만 검사한다. 저장된 과거 값까지 매번 검사하면 규칙이 추가된 날부터 모든 저장이 막힌다.
  if (input.headline !== undefined) assertNoForbiddenClaim(headline, "headline");
  if (input.bio !== undefined) assertNoForbiddenClaim(bio, "bio");

  const publicSettings =
    input.publicSettings !== undefined
      ? { ...(cur.public_settings ?? {}), ...cleanSettings(input.publicSettings) }
      : (cur.public_settings ?? {});

  let next: ProfileRow;
  try {
    const updated = await one<ProfileRow>(
      `UPDATE profiles
          SET slug = $2, display_name = $3, headline = $4, bio = $5,
              specialties = $6, languages = $7, region = $8, public_settings = $9,
              version = version + 1
        WHERE id = $1
        RETURNING *`,
      // $1..$9 — 자리표시자 9개에 인자 9개. `region`($8)이 빠져 있던 버그가 있었다:
      // 인자가 8개뿐이라 `there is no parameter $9` 로 **updateProfile·restoreVersion 이 항상 실패**했고,
      // 값도 한 칸씩 밀려 region 컬럼에 publicSettings JSON 이 들어갔다. 타입체크로는 잡히지 않는다.
      [cur.id, slug, displayName, headline, bio, specialties, languages, region, JSON.stringify(publicSettings)],
      c,
    );
    if (!updated) throw notFound("profile");
    next = updated;
  } catch (e) {
    mapUniqueViolation(e);
  }

  await one(
    `INSERT INTO profile_versions (profile_id, version, snapshot, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [next.id, next.version, JSON.stringify(snapshotOf(next)), ctx.userId],
    c,
  );

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// 소유자 경로 (M02)
// ─────────────────────────────────────────────────────────────────────────────

/** P-020/P-021: 프로필 생성. slug 는 정규화된 값이 저장된다(입력 원문을 저장하지 않는다). */
export async function createProfile(
  ctx: Ctx,
  input: ProfileWriteInput & { slug: string; displayName: string },
): Promise<MyProfile> {
  const userId = await assertOwner(ctx);

  const slug = slugOrThrow(input.slug);
  const displayName = requiredText(input.displayName, DISPLAY_NAME_MAX, "display_name_required", "이름을 입력하세요.");
  const headline = optionalText(input.headline, HEADLINE_MAX);
  const bio = optionalText(input.bio, BIO_MAX);
  const region = optionalText(input.region, REGION_MAX);
  assertNoForbiddenClaim(headline, "headline");
  assertNoForbiddenClaim(bio, "bio");
  const specialties = input.specialties
    ? textList(input.specialties, SPECIALTY_MAX_ITEMS, SPECIALTY_ITEM_MAX, "invalid_specialties")
    : [];
  const languages = input.languages
    ? textList(input.languages, LANGUAGE_MAX_ITEMS, LANGUAGE_ITEM_MAX, "invalid_languages")
    : [];
  const publicSettings = cleanSettings(input.publicSettings);

  return tx(async (c) => {
    let row: ProfileRow;
    try {
      const created = await one<ProfileRow>(
        `INSERT INTO profiles (user_id, slug, display_name, headline, bio, specialties, languages, region, public_settings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [userId, slug, displayName, headline, bio, specialties, languages, region, JSON.stringify(publicSettings)],
        c,
      );
      if (!created) throw unavailable("profile_create_failed", "프로필을 만들 수 없습니다.");
      row = created;
    } catch (e) {
      mapUniqueViolation(e);
    }

    // 버전 1 스냅샷. 첫 저장도 복원 대상이어야 "처음 상태로 되돌리기"가 가능하다 (P-028).
    await one(
      `INSERT INTO profile_versions (profile_id, version, snapshot, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [row.id, row.version, JSON.stringify(snapshotOf(row)), userId],
      c,
    );
    await writeAudit(c, {
      eventType: "profile.created",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: row.id,
      correlationId: ctx.requestId,
      payload: { slug: row.slug },
    });

    return toMyProfile(row);
  });
}

/** 소유자 전용 조회. 공개 뷰가 아니라 원본을 읽지만 `user_id` 조건이 항상 붙는다(IDOR 차단). */
export async function getMyProfile(ctx: Ctx): Promise<MyProfile | null> {
  const userId = requireUser(ctx);
  const row = await one<ProfileRow>(`SELECT * FROM profiles WHERE user_id = $1`, [userId]);
  return row ? toMyProfile(row) : null;
}

/** P-021/P-028/P-029: 저장. 모든 문자열은 `sanitizeText` 를 거치고 저장마다 버전이 하나 생긴다. */
export async function updateProfile(ctx: Ctx, input: ProfileWriteInput): Promise<MyProfile> {
  const userId = await assertOwner(ctx);

  return tx(async (c) => {
    const cur = await lockedProfile(c, userId);
    const next = await writeProfile(c, cur, input, ctx);

    const before = cur.public_settings ?? {};
    const after = next.public_settings ?? {};
    // P-029: 연락처 공개 여부가 바뀐 사실은 따로 남긴다. "언제 공개로 바꿨는가"를 답할 수 있어야 한다.
    const contactVisibilityChanged =
      before.showEmail !== after.showEmail || before.showPhone !== after.showPhone;

    await writeAudit(c, {
      eventType: contactVisibilityChanged ? "profile.contact_visibility_changed" : "profile.updated",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: next.id,
      correlationId: ctx.requestId,
      // 값 원문(이름·소개)은 남기지 않는다 — 감사로그는 "무엇이 바뀐 사실"만 알면 된다 (N-13).
      payload: {
        version: next.version,
        slugChanged: cur.slug !== next.slug,
        showEmail: after.showEmail === true,
        showPhone: after.showPhone === true,
      },
    });

    return toMyProfile(next);
  });
}

/**
 * P-027: 발행. 발행 사실은 외부(검색 인덱스·연동)가 알아야 하므로 **같은 트랜잭션에서** outbox 에 기록한다 (P-183).
 *
 * 최소 내용 요건을 걸지 않는 이유: 어떤 항목이 비었는지는 `guidance`(완성도 안내)로 돌려준다.
 * 발행을 막는 하드 게이트를 임의로 만들면 그것이 곧 "점수가 낮으면 공개 못 한다"가 되어 N-3 과 충돌한다.
 */
export async function publish(ctx: Ctx): Promise<{
  publishedAt: string;
  url: string;
  guidance: { percent: number; missing: string[] };
}> {
  const userId = await assertOwner(ctx);

  const result = await tx(async (c) => {
    const cur = await lockedProfile(c, userId);

    // 저장된 slug 를 다시 검증한다: 예약어 목록이 늘어난 뒤에 과거 slug 가 발행되는 경로를 막는다.
    const verdict = validateSlug(cur.slug);
    if (!verdict.ok || RESERVED_SLUGS.has(cur.slug)) {
      throw badRequest("slug_invalid", "주소를 변경한 뒤 다시 발행하세요.");
    }
    if (sanitizeText(cur.display_name, DISPLAY_NAME_MAX).length === 0) {
      throw badRequest("display_name_required", "이름을 입력한 뒤 발행하세요.");
    }

    const row =
      cur.published_at === null
        ? await one<{ published_at: Date }>(
            `UPDATE profiles SET published_at = now() WHERE id = $1 RETURNING published_at`,
            [cur.id],
            c,
          )
        : { published_at: cur.published_at };
    if (!row) throw unavailable("publish_failed", "발행할 수 없습니다.");

    if (cur.published_at === null) {
      await enqueue(c, {
        eventType: "profile.published",
        aggregateType: "profile",
        aggregateId: cur.id,
        actorId: userId,
        correlationId: ctx.requestId,
        payload: { slug: cur.slug, version: cur.version },
      });
      await writeAudit(c, {
        eventType: "profile.published",
        actorId: userId,
        aggregateType: "profile",
        aggregateId: cur.id,
        correlationId: ctx.requestId,
        payload: { slug: cur.slug },
      });
    }

    return { profileId: cur.id, slug: cur.slug, publishedAt: row.published_at };
  });

  return {
    publishedAt: iso(result.publishedAt) ?? "",
    url: `${appOrigin()}/p/${result.slug}`,
    guidance: await completenessFor(ctx),
  };
}

/** P-027: 비발행. 공개 뷰가 `published_at IS NOT NULL` 을 요구하므로 이 한 줄로 /p/{slug} 가 404 가 된다. */
export async function unpublish(ctx: Ctx): Promise<{ unpublished: true }> {
  const userId = await assertOwner(ctx);

  return tx(async (c) => {
    const cur = await lockedProfile(c, userId);
    if (cur.published_at === null) return { unpublished: true as const };

    await q(`UPDATE profiles SET published_at = NULL WHERE id = $1`, [cur.id], c);
    // 검색 인덱스에서 제거되어야 한다(P-027 수용기준). 공개 중단과 통지가 갈라지면
    // "비발행했는데 검색에는 남아 있다"가 된다 — 같은 트랜잭션이어야 하는 이유다.
    await enqueue(c, {
      eventType: "profile.unpublished",
      aggregateType: "profile",
      aggregateId: cur.id,
      actorId: userId,
      correlationId: ctx.requestId,
      payload: { slug: cur.slug },
    });
    await writeAudit(c, {
      eventType: "profile.unpublished",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: cur.id,
      correlationId: ctx.requestId,
    });
    return { unpublished: true as const };
  });
}

/** P-028: 버전 목록. 스냅샷 본문은 돌려주지 않는다(목록 응답이 프로필 본문 N개가 되면 안 된다). */
export async function listVersions(ctx: Ctx): Promise<{ version: number; createdAt: string | null; createdBy: string | null }[]> {
  const userId = requireUser(ctx);
  const rows = await q<{ version: number; created_at: Date; created_by: string | null }>(
    // 소유자 스코프는 조인으로 건다 — profile_id 만 받으면 남의 버전 목록을 읽을 수 있다.
    `SELECT v.version, v.created_at, v.created_by
       FROM profile_versions v
       JOIN profiles p ON p.id = v.profile_id
      WHERE p.user_id = $1
      ORDER BY v.version DESC`,
    [userId],
  );
  return rows.map((r) => ({ version: r.version, createdAt: iso(r.created_at), createdBy: r.created_by }));
}

/**
 * P-028: 복원. 복원도 **새 버전을 만든다** — 과거 버전을 덮어쓰지 않으므로 이력이 단조 증가한다.
 * 복원 내용도 저장 경로와 같은 sanitize 를 거친다(규칙이 강화된 뒤 과거 값이 되살아나지 않게).
 */
export async function restoreVersion(ctx: Ctx, version: number): Promise<MyProfile> {
  const userId = await assertOwner(ctx);
  if (!Number.isInteger(version) || version < 1) {
    throw badRequest("invalid_version", "복원할 버전을 확인하세요.");
  }

  return tx(async (c) => {
    const cur = await lockedProfile(c, userId);
    const snap = await one<{ snapshot: Record<string, unknown> }>(
      `SELECT snapshot FROM profile_versions WHERE profile_id = $1 AND version = $2`,
      [cur.id, version],
      c,
    );
    if (!snap) throw notFound("profile_version");

    const s = snap.snapshot ?? {};
    const input: ProfileWriteInput = {
      // slug 는 복원 대상에서 **제외**한다: 과거 주소가 이미 다른 사람에게 발급됐을 수 있고,
      // 공개 주소가 되돌아가면 밖에 공유된 링크가 다른 프로필을 가리킬 수 있다.
      displayName: typeof s.displayName === "string" ? s.displayName : cur.display_name,
      headline: typeof s.headline === "string" ? s.headline : null,
      bio: typeof s.bio === "string" ? s.bio : null,
      region: typeof s.region === "string" ? s.region : null,
      specialties: Array.isArray(s.specialties) ? (s.specialties as string[]) : [],
      languages: Array.isArray(s.languages) ? (s.languages as string[]) : [],
      publicSettings:
        s.publicSettings && typeof s.publicSettings === "object" && !Array.isArray(s.publicSettings)
          ? (s.publicSettings as Record<string, unknown>)
          : {},
    };

    const next = await writeProfile(c, cur, input, ctx);
    await writeAudit(c, {
      eventType: "profile.version_restored",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: next.id,
      correlationId: ctx.requestId,
      payload: { restoredFrom: version, newVersion: next.version },
    });
    return toMyProfile(next);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// M03 미니사이트 블록 (P-040 / P-043)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-040 / N-10: 블록 저장. `validateBlocks()` 를 통과한 값만 들어간다.
 *
 * 전체 삭제 → 재삽입인 이유: `profile_blocks` 의 `UNIQUE (profile_id, position)` 이
 * DEFERRABLE INITIALLY DEFERRED 라서 트랜잭션 **커밋 시점**에만 검사된다. 순서 교환(1↔2)을
 * UPDATE 로 하려면 임시 position 이 필요한데, 삭제-재삽입은 그 임시 상태 자체를 없앤다 (P-043).
 */
export async function setBlocks(ctx: Ctx, blocks: unknown): Promise<Block[]> {
  const userId = await assertOwner(ctx);

  const verdict = validateBlocks(blocks);
  if (!verdict.ok) throw badRequest(verdict.code, verdict.message);

  // TODO(P-140): 요금제별 블록 한도(`plans.limits.blocks`)는 billing 모듈이 구독을 읽어 판정한다.
  // 여기서 subscriptions 를 직접 보지 않는 이유는 모듈 경계(전략 §3)를 넘지 않기 위함이다.

  return tx(async (c) => {
    const cur = await lockedProfile(c, userId);
    await q(`DELETE FROM profile_blocks WHERE profile_id = $1`, [cur.id], c);
    for (const b of verdict.blocks) {
      await q(
        `INSERT INTO profile_blocks (profile_id, kind, position, props, visible) VALUES ($1,$2,$3,$4,$5)`,
        [cur.id, b.kind, b.position, JSON.stringify(b.props), b.visible],
        c,
      );
    }
    await writeAudit(c, {
      eventType: "profile.blocks_updated",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: cur.id,
      correlationId: ctx.requestId,
      payload: { count: verdict.blocks.length, kinds: verdict.blocks.map((b) => b.kind) },
    });
    return verdict.blocks;
  });
}

/** 소유자 편집 화면용. 숨긴 블록(visible=false)도 함께 돌려준다 — 공개 경로와 다른 점이다. */
export async function getBlocks(ctx: Ctx): Promise<Block[]> {
  const userId = requireUser(ctx);
  const rows = await q<{ kind: string; position: number; props: Record<string, unknown> | null; visible: boolean }>(
    `SELECT b.kind, b.position, b.props, b.visible
       FROM profile_blocks b
       JOIN profiles p ON p.id = b.profile_id
      WHERE p.user_id = $1
      ORDER BY b.position`,
    [userId],
  );
  // 저장 시점에 schema 를 통과한 값이지만, 읽을 때도 같은 모양으로 맞춘다(렌더러가 분기하지 않게).
  return rows.map((r) => ({
    kind: r.kind as Block["kind"],
    position: r.position,
    props: r.props ?? {},
    visible: r.visible,
  }));
}

/**
 * P-023: 경력·학력 등 자기기재 항목.
 *
 * **`verification_id` 를 절대 쓰지 않는다** (N-1). 이 경로로 들어온 값은 전부 자기기재이고,
 * 검증 연결은 `proof` 모듈이 검증을 끝낸 뒤에만 붙인다. 여기에 verification_id 인자를 만드는 순간
 * "검증됨" 표기를 사용자가 직접 쓸 수 있게 된다.
 *
 * 삭제를 하지 않는 이유: 검증이 붙은 항목을 조용히 지우면 공개 표기와 검증 이력이 어긋난다.
 * TODO(P-023): 항목 삭제는 검증 연결 해제 정책이 정해진 뒤 별도 경로로 만든다.
 */
export async function upsertFacts(ctx: Ctx, facts: readonly FactInput[]): Promise<ProfileFact[]> {
  const userId = await assertOwner(ctx);

  if (!Array.isArray(facts)) throw badRequest("invalid_facts", "항목 목록 형식이 올바르지 않습니다.");
  if (facts.length > FACTS_PER_CALL_MAX) {
    throw badRequest("too_many_facts", `한 번에 최대 ${FACTS_PER_CALL_MAX}개까지 저장할 수 있습니다.`);
  }

  const prepared = facts.map((f, i) => {
    if (!f || typeof f !== "object") throw badRequest("invalid_fact", `${i + 1}번째 항목 형식이 올바르지 않습니다.`);
    if (typeof f.kind !== "string" || !FACT_KINDS.includes(f.kind)) {
      throw badRequest("unknown_fact_kind", `${i + 1}번째 항목의 종류가 올바르지 않습니다.`);
    }
    const label = requiredText(f.label, FACT_LABEL_MAX, "fact_label_required", `${i + 1}번째 항목의 제목을 입력하세요.`);
    const detail = optionalText(f.detail, FACT_DETAIL_MAX);
    assertNoForbiddenClaim(label, "label");
    assertNoForbiddenClaim(detail, "detail");
    return {
      id: typeof f.id === "string" && f.id.length > 0 ? f.id : null,
      kind: f.kind,
      label,
      detail,
      startedOn: dateInput(f.startedOn, `${i + 1}번째 항목의 시작일`),
      endedOn: dateInput(f.endedOn, `${i + 1}번째 항목의 종료일`),
      position: Number.isInteger(f.position) && (f.position as number) >= 0 ? (f.position as number) : i,
    };
  });

  return tx(async (c) => {
    const cur = await lockedProfile(c, userId);
    for (const f of prepared) {
      if (f.id) {
        // 소유자 조건이 WHERE 에 있다. 남의 fact id 를 넣으면 0행이 바뀌고 조용히 넘어간다 —
        // 404 를 돌려주면 "그 id 가 존재한다"는 사실이 드러난다.
        await q(
          `UPDATE profile_facts
              SET kind = $3, label = $4, detail = $5, started_on = $6, ended_on = $7, position = $8
            WHERE id = $1 AND profile_id = $2`,
          [f.id, cur.id, f.kind, f.label, f.detail, f.startedOn, f.endedOn, f.position],
          c,
        );
      } else {
        await q(
          `INSERT INTO profile_facts (profile_id, kind, label, detail, started_on, ended_on, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cur.id, f.kind, f.label, f.detail, f.startedOn, f.endedOn, f.position],
          c,
        );
      }
    }
    await writeAudit(c, {
      eventType: "profile.facts_upserted",
      actorId: userId,
      aggregateType: "profile",
      aggregateId: cur.id,
      correlationId: ctx.requestId,
      payload: { count: prepared.length },
    });

    const rows = await q<{
      id: string;
      kind: string;
      label: string;
      detail: string | null;
      started_on: Date | null;
      ended_on: Date | null;
      verified: boolean;
      position: number;
    }>(
      `SELECT id, kind, label, detail, started_on, ended_on,
              (verification_id IS NOT NULL) AS verified, position
         FROM profile_facts WHERE profile_id = $1 ORDER BY position, created_at`,
      [cur.id],
      c,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      detail: r.detail,
      startedOn: dateOnly(r.started_on),
      endedOn: dateOnly(r.ended_on),
      verified: r.verified === true,
      position: r.position,
    }));
  });
}

function dateInput(v: unknown, what: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw badRequest("invalid_date", `${what}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 경로 (N-4 / ADR-002) — 여기서 원본 테이블을 읽지 않는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-025/P-026: 공개 프로필. **인증 없이** 호출되며 `Ctx` 를 받지 않는다(받을 것이 없다).
 *
 * 네 개의 공개 뷰만 읽는다 — `profiles`·`badges`·`metric_claims`·`offers` 원본을 직접 읽지 않는다.
 * 뷰가 이미 (a) 미발행·정지·삭제 계정 제외, (b) 만료·취소 배지 **읽기 시점** 제외(N-9),
 * (c) 기간·표본 없는 지표 제외(N-8), (d) 가격 정책에 따른 금액 마스킹을 하고 있다.
 * 그 다음 `pickPublic()`/`toPublicBadges()` 로 **다시 조립**해서 allowlist 밖 키가 응답 객체에
 * 존재하지 않게 만든다(delete 가 아니라 재구성이다 — 삭제는 빠뜨릴 수 있고 재구성은 빠뜨릴 수 없다).
 *
 * @param now 만료 판정 기준 시각. 도메인이 `Date.now()` 를 쓰지 않으므로 호출부가 넘긴다(N-9 테스트 재현성).
 */
export async function getPublicProfile(
  slug: string,
  now: Date = new Date(),
  viewer?: PublicViewer,
): Promise<PublicProfileDto> {
  // 대소문자·전각 혼동으로 다른 사람의 주소가 열리지 않게 접은 뒤 조회한다 (P-020).
  const key = normalizeSlug(typeof slug === "string" ? slug : "");
  if (key.length === 0) throw notFound("profile");

  await limitPublicView(viewer, key);

  const prof = await one<{
    id: string;
    slug: string;
    display_name: string;
    headline: string | null;
    bio: string | null;
    specialties: string[];
    languages: string[];
    region: string | null;
    published_at: Date | null;
  }>(
    `SELECT id, slug, display_name, headline, bio, specialties, languages, region, published_at
       FROM public_profile_view WHERE slug = $1`,
    [key],
  );
  if (!prof) throw notFound("profile");

  const [badgeRows, metricRows, offerRows, blockRows, issuerTypes, factRows] = await Promise.all([
    q<{
      id: string;
      badge_type: string;
      public_label: string;
      method: VerificationMethod;
      scope: string;
      issuer_name: string | null;
      verified_at: Date | null;
      expires_at: Date | null;
      status: string;
    }>(
      `SELECT id, badge_type, public_label, method, scope, issuer_name, verified_at, expires_at, status
         FROM public_badge_view WHERE profile_id = $1`,
      [prof.id],
    ),
    q<{
      metric_code: string;
      value_numeric: string;
      unit: string;
      period_start: Date | null;
      period_end: Date | null;
      sample_size: number;
      basis: string;
      verified: boolean;
    }>(
      `SELECT metric_code, value_numeric, unit, period_start, period_end, sample_size, basis, verified
         FROM public_metric_view WHERE profile_id = $1 ORDER BY period_end DESC`,
      [prof.id],
    ),
    q<{
      id: string;
      title: string;
      description: string | null;
      price_display_policy: string;
      price_amount: string | null;
      price_currency: string | null;
      external_url: string | null;
      owner_type: string;
    }>(
      `SELECT id, title, description, price_display_policy, price_amount, price_currency, external_url, owner_type
         FROM public_offer_view WHERE profile_id = $1 ORDER BY title`,
      [prof.id],
    ),
    // 블록은 "무엇을 어떤 순서로 보일지"만 담은 레이아웃이고(N-10 화이트리스트를 이미 통과했다),
    // 신뢰 정보·연락처는 하나도 들고 있지 않다. 그래서 공개 뷰가 따로 없고 여기서 직접 읽는다.
    q<{ kind: string; position: number; props: Record<string, unknown> | null }>(
      `SELECT kind, position, props FROM profile_blocks
        WHERE profile_id = $1 AND visible = true ORDER BY position`,
      [prof.id],
    ),
    // 발급기관이 필수인 유형은 발급기관이 비면 배지를 숨긴다 (P-058). 판정 근거는 참조 테이블이다.
    q<{ code: string }>(`SELECT code FROM evidence_types WHERE requires_issuer = true`),
    /**
     * P-023 경력·학력 항목. 공개 뷰를 따로 두지 않고 여기서 읽는 이유:
     * `profile_facts` 에는 비공개 필드가 없고(label·detail·기간뿐), 공개 여부는 프로필 발행
     * 하나로 결정된다 — 이 쿼리는 이미 발행 확인을 통과한 `prof.id` 로만 돈다.
     *
     * provenance 는 `verification_id` 가 가리키는 검증의 **강도**다. 검증이 verified 가 아니면
     * (반려·만료·분쟁) 자기기재로 떨어뜨린다 — "한때 확인됐다" 를 "확인됨" 으로 보여주면 N-1 위반이다.
     */
    q<{
      kind: string;
      label: string;
      detail: string | null;
      started_on: Date | null;
      ended_on: Date | null;
      method: VerificationMethod | null;
    }>(
      `SELECT f.kind, f.label, f.detail, f.started_on, f.ended_on,
              CASE WHEN v.status = 'verified'
                        AND v.method <> 'self_declared'
                        AND (v.expires_at IS NULL OR v.expires_at > now())
                   THEN v.method END AS method
         FROM profile_facts f
         LEFT JOIN verifications v ON v.id = f.verification_id
        WHERE f.profile_id = $1
        ORDER BY f.position, f.started_on DESC NULLS LAST`,
      [prof.id],
    ),
  ]);

  const issuerRequired = new Set(issuerTypes.map((r) => r.code));
  const badges = toPublicBadges(
    badgeRows.map<BadgeRow>((b) => ({
      id: b.id,
      badgeType: b.badge_type,
      publicLabel: b.public_label,
      method: b.method,
      scope: b.scope,
      issuerName: b.issuer_name,
      status: toBadgeStatus(b.status),
      verifiedAt: b.verified_at,
      expiresAt: b.expires_at,
    })),
    now,
    issuerRequired,
  );

  const metrics = metricRows.map((m) =>
    pickPublic<PublicMetric, typeof PUBLIC_METRIC_FIELDS>(
      {
        metricCode: m.metric_code,
        value: num(m.value_numeric),
        unit: m.unit,
        periodStart: dateOnly(m.period_start),
        periodEnd: dateOnly(m.period_end),
        sampleSize: m.sample_size,
        basis: m.basis,
        verified: m.verified === true,
      },
      PUBLIC_METRIC_FIELDS,
    ),
  );

  const offers = offerRows.map((o) =>
    pickPublic<PublicOffer, typeof PUBLIC_OFFER_FIELDS>(
      {
        id: o.id,
        title: o.title,
        description: o.description,
        priceDisplayPolicy: o.price_display_policy,
        priceAmount: o.price_amount === null ? null : num(o.price_amount),
        priceCurrency: o.price_currency,
        externalUrl: o.external_url,
        ownerType: o.owner_type,
      },
      PUBLIC_OFFER_FIELDS,
    ),
  );

  const facts: PublicFact[] = factRows.map((f) => ({
    kind: f.kind,
    label: f.label,
    detail: f.detail,
    startedOn: dateOnly(f.started_on),
    endedOn: dateOnly(f.ended_on),
    method: f.method,
  }));

  const profileFields = pickPublic<
    Omit<PublicProfileDto, "badges" | "metrics" | "offers" | "blocks" | "facts">,
    typeof PUBLIC_PROFILE_FIELDS
  >(
    {
      slug: prof.slug,
      displayName: prof.display_name,
      headline: prof.headline,
      bio: prof.bio,
      specialties: prof.specialties ?? [],
      languages: prof.languages ?? [],
      region: prof.region,
      publishedAt: iso(prof.published_at),
    },
    PUBLIC_PROFILE_FIELDS,
  );

  const trustPayload = { ...profileFields, badges, metrics, offers, facts };

  // 개발·테스트에서만 도는 트립와이어(N-4). allowlist 를 우회하는 경로(직접 JSON 조립 등)가 생기면
  // 여기서 터져 PR 이 통과하지 못한다. 운영 핫패스에서는 돌리지 않는다(공개 프로필 p75 < 2.5s, P-194).
  //
  // 블록을 이 검사에 넣지 않는 이유: `NEVER_PUBLIC_KEYS` 의 'note' 는 검증자 메모·리드 메모를 겨냥한
  // 이름인데, 블록 props 의 'note' 는 사용자가 직접 쓴 **공개 안내문**이라 이름만 겹친다.
  // 블록은 저장 시 `validateBlocks()` 화이트리스트를 통과했고 그쪽이 N-10 의 가드다.
  if (process.env.NODE_ENV !== "production") assertNoPrivateKeys(trustPayload);

  return {
    ...trustPayload,
    blocks: blockRows.map((b) => ({ kind: b.kind, position: b.position, props: b.props ?? {} })),
  };
}

function toBadgeStatus(v: string): BadgeRow["status"] {
  return v === "expired" || v === "revoked" || v === "disputed" ? v : "active";
}

/**
 * P-035: vCard. **공개 동의된 연락처만** 들어간다.
 *
 * 공개 뷰에 `public_settings`·이메일·전화가 **없는 것이 설계**라서(N-4) 여기서는 원본을 읽되
 * 판정을 `publicContact()` 에 맡긴다 — 플래그 해석이 이 파일에 복사되면 공개 기준이 두 곳에 생긴다.
 * 연락처가 하나라도 들어갔으면 `X-PROPLUS-CONTACT-PUBLIC:1` 줄을 붙인다: vCard 는 우리 손을 떠나는
 * 산출물이므로, "연락처를 넣었는가"를 테스트가 문자열 하나로 확인할 수 있어야 한다.
 */
/**
 * P-031: sitemap 에 넣을 **발행된** 프로필 slug 목록.
 *
 * 왜 `searchProfiles` 를 쓰지 않는가: 그것은 랭킹·`placement`·`dropped` 가 붙은 검색 응답이고
 * (N-15), 전수 목록이 아니다. sitemap 은 "지금 공개된 주소 전부" 가 필요하므로 전용 함수를 둔다.
 *
 * `public_profile_view` 만 읽는다 — 미발행·정지·삭제 계정은 뷰가 이미 걸러낸다(P-027).
 * 그래서 비공개 프로필 주소가 sitemap 으로 새어 나갈 경로가 없다.
 *
 * `limit` 은 sitemap 한 장의 상한(50,000)보다 작게 둔다. 그 이상이 되면 sitemap index 로
 * 쪼개야 하고, 그때 이 함수에 커서를 더한다.
 */
export async function publishedSlugs(limit = 20_000): Promise<{ slug: string; updatedAt: string | null }[]> {
  const rows = await q<{ slug: string; published_at: Date | null }>(
    `SELECT slug, published_at FROM public_profile_view ORDER BY published_at DESC NULLS LAST LIMIT $1`,
    [Math.max(1, Math.min(50_000, limit))],
  );
  return rows.map((r) => ({ slug: r.slug, updatedAt: iso(r.published_at) }));
}

/**
 * P-169: 지금 유효한 정책 버전. 공개 상담 폼이 동의 레코드에 적을 값이다.
 *
 * 화면에 상수로 박으면 정책이 바뀌어도 폼은 옛 버전을 계속 기록하고, 그 동의가 **무엇에 대한
 * 동의인지** 사후에 설명되지 않는다(보안정책 §3 "policy_version 과 함께 기록").
 * `effective_at` 이 지난 것 중 최신을 고른다 — 미래 발효 정책을 미리 기록하지 않는다.
 */
export async function currentPolicyVersion(kind: "privacy" | "terms" | "verification" | "cancellation"): Promise<string | null> {
  const row = await one<{ version: string }>(
    `SELECT version FROM policy_versions
      WHERE kind = $1 AND effective_at <= now()
      ORDER BY effective_at DESC LIMIT 1`,
    [kind],
  );
  return row?.version ?? null;
}

export async function vcardFor(slug: string, viewer?: PublicViewer): Promise<string> {
  const key = normalizeSlug(typeof slug === "string" ? slug : "");
  if (key.length === 0) throw notFound("profile");

  await limitPublicView(viewer, key);

  // 발행된 프로필만. 미발행 프로필의 vCard 가 나가면 비발행이 공개 중단으로 작동하지 않는다 (P-027).
  const prof = await one<{ id: string; slug: string; display_name: string; headline: string | null }>(
    `SELECT id, slug, display_name, headline FROM public_profile_view WHERE slug = $1`,
    [key],
  );
  if (!prof) throw notFound("profile");

  const owner = await one<{ public_settings: Record<string, unknown> | null; email: string | null; phone: string | null }>(
    `SELECT p.public_settings, u.email, u.phone
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1`,
    [prof.id],
  );
  const contact = publicContact(owner?.public_settings ?? {}, {
    email: owner?.email ?? null,
    phone: owner?.phone ?? null,
  });

  // 소속은 **검증된 소속 배지**에서만 가져온다 (N-1). 자기기재 소속을 vCard 에 박으면
  // 그 파일은 우리 손을 떠난 뒤에도 "확인된 소속"처럼 읽힌다 — 되돌릴 수 없는 종류의 과장이다.
  const affiliation = await one<{ issuer_name: string | null }>(
    `SELECT issuer_name FROM public_badge_view
      WHERE profile_id = $1 AND badge_type = 'affiliation' AND status = 'active'
      ORDER BY verified_at DESC LIMIT 1`,
    [prof.id],
  );

  const vcard = buildVCard({
    displayName: prof.display_name,
    headline: prof.headline,
    org: affiliation?.issuer_name ?? null,
    url: `${appOrigin()}/p/${prof.slug}`,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
  });

  if (!contact.email && !contact.phone) return vcard;
  const marker = "X-PROPLUS-CONTACT-PUBLIC:1\r\n";
  const at = vcard.lastIndexOf("END:VCARD");
  return at < 0 ? vcard : `${vcard.slice(0, at)}${marker}${vcard.slice(at)}`;
}

/**
 * P-032 / N-3: 완성도 **안내**. 점수가 아니다.
 *
 * 반환값은 본인 워크스페이스 전용이다 — 공개 DTO 에 넣지 않고(`NEVER_PUBLIC_KEYS` 에
 * 'completeness' 가 있어 섞이면 `assertNoPrivateKeys()` 가 터진다) 검색 정렬 키로도 쓰지 않는다(N-15).
 */
export async function completenessFor(ctx: Ctx): Promise<{ percent: number; missing: string[] }> {
  const userId = requireUser(ctx);

  const row = await one<{
    headline: string | null;
    bio: string | null;
    specialties: string[];
    public_settings: Record<string, unknown> | null;
    badge_count: string;
    offer_count: string;
    has_contact_block: boolean;
  }>(
    // 배지 수는 `public_badge_view` 에서 센다: 만료·취소된 배지를 "있다"로 세면 안내가 거짓말이 된다(N-9).
    `SELECT p.headline, p.bio, p.specialties, p.public_settings,
            (SELECT count(*) FROM public_badge_view b WHERE b.profile_id = p.id) AS badge_count,
            (SELECT count(*) FROM offers o WHERE o.profile_id = p.id AND o.status <> 'archived') AS offer_count,
            EXISTS (SELECT 1 FROM profile_blocks pb
                     WHERE pb.profile_id = p.id AND pb.kind = 'contact' AND pb.visible) AS has_contact_block
       FROM profiles p
      WHERE p.user_id = $1`,
    [userId],
  );
  if (!row) throw notFound("profile");

  const settings = row.public_settings ?? {};
  const ctaLabel = typeof settings.ctaLabel === "string" ? settings.ctaLabel.trim() : "";

  return profileCompleteness({
    hasHeadline: (row.headline ?? "").trim().length > 0,
    hasBio: (row.bio ?? "").trim().length > 0,
    specialtyCount: (row.specialties ?? []).length,
    badgeCount: num(row.badge_count),
    offerCount: num(row.offer_count),
    // P-036: 상담 CTA 는 블록으로도, 공개 설정의 라벨로도 구성할 수 있다. 둘 중 하나면 "설정됨"이다.
    hasCta: row.has_contact_block === true || ctaLabel.length > 0,
  });
}
