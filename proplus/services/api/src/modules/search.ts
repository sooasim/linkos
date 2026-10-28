/**
 * M11 Search & Discovery — P-150 전문가 검색 · P-151 검증 상태 필터 · P-152 유료 노출 구분 ·
 * P-153 랭킹 근거 공개 · P-154 인덱스 어댑터 · P-155 삭제·비공개 동기화 · P-156 zero-result 기록.
 *
 * 출처: 모듈명세 M11("광고/유료 노출은 일반 검색결과와 구분하고 랭킹 근거를 공개한다")
 *       + ADR-005(색인 입력은 공개 뷰뿐) + ADR-006(Meilisearch 실사 전 Postgres 폴백).
 *
 * ## 이 모듈을 지배하는 세 규칙
 *
 * 1. **N-15 — 설명할 수 없는 결과는 결과가 아니다.** 모든 결과에 `placement` 와 `rankingBasis[]` 를 채우고,
 *    반환 **직전** `validateSearchResults()` 를 호출한다. 근거가 빈 결과가 섞이면 그 함수가 런타임에 던진다.
 *    그래서 급할 때도 "근거 없는 결과"를 내보낼 수 없다 — 근거를 만들 수 없는 행은 아예 응답에서 **버린다**
 *    (`domain/search.ts` 가 말하는 "필터링 책임은 검색 모듈에 있다").
 * 2. **N-3 / P-151 — 점수가 없다.** 검증 상태 필터는 배지 **보유 여부**로만 거른다. 배지 수·강도로
 *    순서를 바꾸는 코드를 만들지 않는다. 정렬은 "최근 발행 순"이고, 그 사실 자체가 공개 근거 코드
 *    (`recently_active`)로 설명된다. 신뢰도를 정렬키로 만드는 순간 그것이 곧 단일 신뢰점수다.
 * 3. **P-197 / ADR-005 — 색인 입력은 `public_profile_view` 뿐이다.** `profiles` 원본을 읽지 않는다.
 *    필터 한 줄의 실수가 유출이 되지 않게, 비공개 필드가 색인에 **들어올 경로 자체를** 없앤다.
 */

import { RANKING_BASIS_CODES, buildRankingBasis, sanitizeText, validateSearchResults } from "@proplus/domain";
import type { Placement, SearchResult } from "@proplus/domain";
import { one, q } from "../lib/db";
import { badRequest } from "../lib/errors";
import { log } from "../lib/log";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 500;
const QUERY_MAX = 80;
const MAX_FILTER_VALUES = 10;
/** 발행 시각이 이 안이면 `recently_active` 근거가 붙는다. 근거 코드는 재현 가능해야 하므로 상수로 고정한다. */
export const RECENTLY_ACTIVE_DAYS = 90;
/** pg_trgm 유사도 하한. 올리면 오타 관용이 줄고 내리면 무관한 결과가 늘어난다 (P-157 은 P2). */
const TRIGRAM_THRESHOLD = 0.3;

/** M09 의 테이블에 적는 사건 이름. `modules/analytics.ts` 의 `ANALYTICS_KINDS` 와 같은 값이어야 한다. */
const ZERO_RESULT_KIND = "search.zero_result";

export interface SearchInput {
  /** 자유 검색어. **저장하지 않는다** — zero-result 기록에도 원문이 들어가지 않는다 (P-156). */
  q?: string | null;
  specialties?: readonly string[] | null;
  region?: string | null;
  /** P-151: 배지 보유 여부로만 거른다. 강도·개수로 정렬하지 않는다 (N-3). */
  verifiedOnly?: boolean;
  /** 특정 배지 유형 보유 필터 (`evidence_types.code`). */
  badgeTypes?: readonly string[] | null;
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  /** 정규화된 질의. 화면이 "무엇으로 찾았는지"를 그대로 보여줄 수 있어야 한다. */
  query: {
    q: string | null;
    specialties: string[];
    region: string | null;
    verifiedOnly: boolean;
    badgeTypes: string[];
    limit: number;
    offset: number;
  };
  /** 일반(무료) 결과. */
  results: SearchResult[];
  /**
   * 유료 노출 자리 (N-15 / P-152). **현재는 항상 빈 배열이다** — 광고 상품도, 노출 판매 테이블도 없다.
   * 구조만 두는 이유: 나중에 유료 노출을 붙일 때 "일반 결과 배열에 섞어 넣는" 가장 쉬운 길을 미리 막아 두는 것이다.
   * 여기에 값이 들어오면 `placement='promoted'` 와 근거 `promoted_placement` 가 강제된다.
   */
  promoted: SearchResult[];
  /** 근거를 만들 수 없어 응답에서 제외된 행 수. 투명성 수치이자 질의 설계의 품질 신호다. */
  dropped: number;
  /** 결과 조립 기준. 응답만 보고도 무엇이 순서를 정했는지 알 수 있어야 한다. */
  basis: {
    sort: string;
    engine: string;
    codes: readonly string[];
  };
}

export interface SearchIndexDoc {
  profileId: string;
  slug: string;
  displayName: string;
  headline: string | null;
  specialties: string[];
  region: string | null;
  publishedAt: string | null;
}

/**
 * P-154 / ADR-006: 검색 엔진 교체 지점.
 *
 * Meilisearch 는 **설치하지 않는다** — 오픈소스검토 §4 체크리스트(LICENSE 원문·SPDX·커밋 해시 고정·CVE·
 * 의존성 스캔·SBOM·법률검토 기록)가 하나도 완료되지 않았다. 실사가 끝나면 이 인터페이스의 구현을
 * 추가하기만 하면 된다. 어댑터의 최종 위치는 ADR-006 이 `services/api/src/lib/searchIndex.ts` 로 정해 두었고,
 * 그 파일이 생기면 이 인터페이스를 그쪽으로 옮긴다(여기서는 재수출만 남긴다).
 */
export interface SearchIndexAdapter {
  readonly name: string;
  upsert(doc: SearchIndexDoc): Promise<void>;
  remove(profileId: string): Promise<void>;
}

/**
 * 실사 전 폴백. **Postgres 에서는 공개 뷰가 곧 색인이다** — 별도 색인이 없으니 올릴 것도 지울 것도 없다.
 * 그래서 두 함수가 no-op 인 것이 정상이고, 이것이 P-155("비공개·삭제 시 즉시 제거")를 공짜로 만족시킨다:
 * `public_profile_view` 가 `published_at IS NOT NULL AND users.status='active'` 를 보므로
 * 비공개 전환·삭제가 **다음 조회에서 즉시** 반영된다(동기화 지연 창이 없다).
 */
const postgresIndex: SearchIndexAdapter = {
  name: "postgres",
  async upsert(): Promise<void> {
    return;
  },
  async remove(): Promise<void> {
    return;
  },
};

export function searchIndexAdapter(): SearchIndexAdapter {
  // TODO(P-154 / ADR-006): 실사 완료 후 `PROPLUS_SEARCH_ENGINE=meili` 분기를 여기에 추가한다.
  return postgresIndex;
}

type ProfileSearchRow = {
  id: string;
  slug: string;
  display_name: string;
  headline: string | null;
  specialties: string[];
  region: string | null;
  published_at: Date | null;
  badge_types: string[] | null;
};

/** ILIKE 와이드카드(`%`, `_`)를 사용자 입력에서 중화한다. SQL 주입이 아니라 **패턴 주입** 방어다. */
function likePattern(text: string): string {
  return `%${text.replace(/([\\%_])/g, "\\$1")}%`;
}

function normalizeList(values: readonly string[] | null | undefined): string[] {
  if (!values || !Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const clean = sanitizeText(v, 60);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_FILTER_VALUES) break;
  }
  return out;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * P-150: 전문가 검색. 발행·공개된 프로필만, `public_profile_view` 기반.
 *
 * `Ctx` 를 받지 않는다 — 검색은 비회원 경로이고 권한에 따라 결과가 달라지지 않는다(공개 뷰가 이미 경계다).
 * rate limit(P-189 `search` 버킷 60/1m)은 요청 주체를 아는 라우트가 건다.
 *
 * `now` 를 인자로 받는 이유: `recently_active` 근거가 시각에 의존한다. 근거가 재현 가능해야 하므로
 * 테스트에서 시각을 고정할 수 있어야 한다 (N-15).
 */
export async function searchProfiles(input: SearchInput, now: Date = new Date()): Promise<SearchResponse> {
  const rawQuery = typeof input?.q === "string" ? sanitizeText(input.q, QUERY_MAX) : "";
  const queryText = rawQuery.length > 0 ? rawQuery : null;
  const specialties = normalizeList(input?.specialties);
  const region = typeof input?.region === "string" && input.region.trim() ? sanitizeText(input.region, 60) : null;
  const badgeTypes = normalizeList(input?.badgeTypes);
  const verifiedOnly = input?.verifiedOnly === true || badgeTypes.length > 0;
  const limit = clampInt(input?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(input?.offset, 0, 0, MAX_OFFSET);

  if (!queryText && specialties.length === 0 && !region && !verifiedOnly) {
    // 조건 없는 전수 조회는 검색이 아니라 디렉터리 덤프다. 그런 응답은 근거도 만들 수 없다(N-15).
    throw badRequest("query_required", "검색어 또는 필터를 하나 이상 지정하세요.");
  }

  const rows = await q<ProfileSearchRow>(
    `WITH base AS (
       SELECT v.id, v.slug, v.display_name, v.headline, v.specialties, v.region, v.published_at
         FROM public_profile_view v
        WHERE ($1::text IS NULL
               OR v.display_name ILIKE $2
               OR coalesce(v.headline, '') ILIKE $2
               OR EXISTS (SELECT 1 FROM unnest(v.specialties) AS s WHERE s ILIKE $2)
               OR similarity(v.display_name, $1) >= $3)
          AND ($4::text[] IS NULL OR v.specialties && $4::text[])
          AND ($5::text IS NULL OR v.region = $5)
     ), badged AS (
       SELECT b.profile_id, array_agg(DISTINCT b.badge_type) AS badge_types
         FROM public_badge_view b
        WHERE b.profile_id IN (SELECT id FROM base)
        GROUP BY b.profile_id
     )
     SELECT b.id::text AS id, b.slug, b.display_name, b.headline, b.specialties, b.region, b.published_at,
            g.badge_types
       FROM base b
       LEFT JOIN badged g ON g.profile_id = b.id
      WHERE ($6::boolean IS NOT TRUE OR g.profile_id IS NOT NULL)
        AND ($7::text[] IS NULL OR g.badge_types && $7::text[])
      ORDER BY b.published_at DESC NULLS LAST, b.slug
      LIMIT $8 OFFSET $9`,
    [
      queryText,
      queryText ? likePattern(queryText) : null,
      TRIGRAM_THRESHOLD,
      specialties.length > 0 ? specialties : null,
      region,
      verifiedOnly,
      badgeTypes.length > 0 ? badgeTypes : null,
      limit,
      offset,
    ],
  );

  const lowerQuery = queryText ? queryText.toLowerCase() : null;
  const recentCutoff = now.getTime() - RECENTLY_ACTIVE_DAYS * 86_400_000;

  const results: SearchResult[] = [];
  let dropped = 0;

  for (const r of rows) {
    const rowSpecialties = Array.isArray(r.specialties) ? r.specialties : [];
    const rowBadges = Array.isArray(r.badge_types) ? r.badge_types : [];

    // 근거는 "질의와 결과를 비교한 사실"에서만 나온다. 추측·가중치는 넣지 않는다 (N-15).
    const specialtyMatch =
      specialties.length > 0
        ? rowSpecialties.some((s) => specialties.includes(s))
        : lowerQuery !== null && rowSpecialties.some((s) => s.toLowerCase().includes(lowerQuery));
    const regionMatch =
      region !== null
        ? r.region === region
        : lowerQuery !== null && r.region !== null && r.region.toLowerCase().includes(lowerQuery);
    const hasBadge = rowBadges.length > 0;
    const recentlyActive = r.published_at !== null && r.published_at.getTime() >= recentCutoff;

    const rankingBasis = buildRankingBasis({
      specialtyMatch,
      regionMatch,
      hasBadge,
      recentlyActive,
      // 유료 노출 소스가 없으므로 항상 false 다. 구조만 남겨 둔다 (P-152).
      promoted: false,
    });

    if (rankingBasis.length === 0) {
      // 이름만 스쳐 맞았고 전문분야·지역·배지·최근활동 중 어느 것도 설명할 수 없는 행이다.
      // 근거 없는 결과를 내보내지 않는다는 약속(N-15)이 여기서 "버린다"로 구현된다.
      dropped += 1;
      continue;
    }

    const placement: Placement = "organic";
    results.push({
      profileId: r.id,
      slug: r.slug,
      displayName: r.display_name,
      headline: r.headline,
      specialties: rowSpecialties,
      region: r.region,
      // 배지 **유형**만. 강도·발급기관·검증일은 상세 화면에서 본다 (N-3: 목록에 정렬 근거를 두지 않는다).
      badgeTypes: rowBadges,
      placement,
      rankingBasis,
    });
  }

  if (dropped > 0) log("info", "search.dropped_unexplainable", { dropped, hasQuery: queryText !== null });

  const promoted: SearchResult[] = [];

  // N-15 의 마지막 관문. 여기서 던지면 배포 전에 드러난다 — 운영에서 근거 없는 결과가 나가는 쪽보다 낫다.
  validateSearchResults([...promoted, ...results]);

  if (results.length === 0) {
    // P-156: 범주만 기록한다. 실패해도 검색 응답을 막지 않는다 — 통계가 본업보다 중요할 수 없다.
    await zeroResultLog({
      hasText: queryText !== null,
      specialtyCount: specialties.length,
      hasRegion: region !== null,
      verifiedOnly,
      badgeTypeCount: badgeTypes.length,
    }).catch((e) => log("warn", "search.zero_result_log_failed", { error: (e as Error).message }));
  }

  return {
    query: { q: queryText, specialties, region, verifiedOnly, badgeTypes, limit, offset },
    results,
    promoted,
    dropped,
    basis: {
      sort: "published_at DESC, slug ASC — 검증 강도·배지 수는 정렬에 쓰지 않는다 (N-3)",
      engine: `${postgresIndex.name} (pg_trgm 유사도 ${TRIGRAM_THRESHOLD} 이상 또는 부분일치)`,
      codes: RANKING_BASIS_CODES,
    },
  };
}

/**
 * P-155/P-197: 색인 갱신. **읽는 곳은 `public_profile_view` 하나뿐이다.**
 *
 * 뷰에 행이 없다는 것은 "비공개 전환·정지·삭제" 중 하나다. 그 경우 **색인에서 제거한다** —
 * 왜 비공개가 되었는지 알 필요가 없고, 알려고 `profiles` 를 읽으면 그 순간 P-197 이 깨진다.
 */
export async function reindexProfile(profileId: string): Promise<{ indexed: boolean; removed: boolean }> {
  if (typeof profileId !== "string" || profileId.trim() === "") throw badRequest("invalid_profile_id");

  const row = await one<{
    id: string;
    slug: string;
    display_name: string;
    headline: string | null;
    specialties: string[];
    region: string | null;
    published_at: Date | null;
  }>(
    `SELECT id::text AS id, slug, display_name, headline, specialties, region, published_at
       FROM public_profile_view
      WHERE id = $1`,
    [profileId],
  );

  const adapter = searchIndexAdapter();
  if (!row) {
    await adapter.remove(profileId);
    log("info", "search.index_removed", { profileId, engine: adapter.name });
    return { indexed: false, removed: true };
  }

  await adapter.upsert({
    profileId: row.id,
    slug: row.slug,
    displayName: row.display_name,
    headline: row.headline,
    specialties: Array.isArray(row.specialties) ? row.specialties : [],
    region: row.region,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  });
  return { indexed: true, removed: false };
}

/** P-155: 비공개·삭제 즉시 제거. Postgres 폴백에서는 공개 뷰가 색인이므로 어댑터 호출만 한다. */
export async function removeFromIndex(profileId: string): Promise<{ removed: boolean }> {
  if (typeof profileId !== "string" || profileId.trim() === "") throw badRequest("invalid_profile_id");
  const adapter = searchIndexAdapter();
  await adapter.remove(profileId);
  log("info", "search.index_removed", { profileId, engine: adapter.name });
  return { removed: true };
}

export interface ZeroResultInput {
  hasText: boolean;
  specialtyCount: number;
  hasRegion: boolean;
  verifiedOnly: boolean;
  badgeTypeCount?: number;
}

/**
 * P-156: 결과 0건 기록 — **검색어 원문 대신 범주만** 남긴다.
 *
 * 왜 원문을 저장하지 않는가: 검색어에는 사람 이름·회사명·전화번호가 그대로 들어온다(실제로 들어온다).
 * 그것을 모아 두면 "누가 누구를 찾았는지"의 로그가 되고, 그건 분석 데이터가 아니라 PII 데이터셋이다
 * (보안정책 §3 / N-13). 공백을 메우는 데 필요한 정보는 "어떤 **조합**으로 찾았을 때 0건이었나"이고,
 * 그건 범주 신호만으로 충분하다.
 *
 * 저장 위치가 `analytics_events`(M09 의 테이블)인 것은 의도적이다: 모듈 간 import 로 결합을 만들지 않으면서
 * 시계열 집계를 한 곳에 모은다. `profile_id` 는 NULL(특정 프로필의 사건이 아니다)이고
 * `kind` 는 `analytics.ANALYTICS_KINDS` 의 `search.zero_result` 와 같은 값을 쓴다.
 */
export async function zeroResultLog(input: ZeroResultInput): Promise<{ recorded: boolean }> {
  const specialtyCount = clampInt(input?.specialtyCount, 0, 0, MAX_FILTER_VALUES);
  const badgeTypeCount = clampInt(input?.badgeTypeCount ?? 0, 0, 0, MAX_FILTER_VALUES);

  // 범주 서명. 검색어·전문분야 **값**은 들어가지 않는다 — 어떤 축을 썼는지와 개수만이다.
  const facets = [
    input?.hasText ? "text" : null,
    specialtyCount > 0 ? `specialty:${specialtyCount}` : null,
    input?.hasRegion ? "region" : null,
    input?.verifiedOnly ? "verified" : null,
    badgeTypeCount > 0 ? `badge_type:${badgeTypeCount}` : null,
  ].filter((v): v is string => v !== null);

  await q(
    `INSERT INTO analytics_events (profile_id, kind, target, visitor_hash, referrer_host)
     VALUES (NULL, $1, $2, NULL, NULL)`,
    [ZERO_RESULT_KIND, facets.length > 0 ? facets.join("+") : "none"],
  );
  return { recorded: true };
}

// TODO(P-157): typo tolerance 는 지금 pg_trgm 유사도 하한 하나로 흉내만 낸다. 본격적인 오타 관용은
//   검색엔진 기능이므로 ADR-006 실사 후 어댑터 쪽에서 구현한다.
// TODO(P-158): 추천은 만들지 않는다. "근거를 제시할 수 없는 추천은 하지 않는다"(P-158 수용기준)이고,
//   현재 근거 코드 집합(`RANKING_BASIS_CODES`)으로 설명할 수 없는 추천은 N-15 위반이다.
