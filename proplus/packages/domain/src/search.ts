/**
 * 검색 결과 투명성 — N-15 (모듈명세 M11 / 브랜드 §3).
 * P-152 광고·유료 노출 구분, P-153 랭킹 근거 공개.
 *
 * 이 파일의 목적은 랭킹을 계산하는 것이 **아니다.** 랭킹 점수는 아예 존재하지 않는다(N-3).
 * 여기 있는 것은 "결과마다 왜 올라왔는지 말할 수 있는가"를 **런타임에 강제하는 장치**다.
 *
 * 왜 런타임에 던지는가:
 *   근거 없는 추천은 타입으로 막을 수 없다. `rankingBasis: string[]` 는 빈 배열도
 *   문법적으로 정상이고, 급할 때 누군가 `rankingBasis: []` 로 응답을 내보낸다.
 *   그 순간 PROPLUS 의 차별점(설명 가능한 노출)이 조용히 사라진다. 그래서
 *   조립 단계에서 예외로 터뜨려 **배포 전에** 드러나게 한다.
 */

/** N-15: 유료 노출은 일반 결과와 섞이지 않는다. UI 는 이 값으로 시각적으로 구분한다. */
export type Placement = "organic" | "promoted";

export interface SearchResult {
  profileId: string;
  slug: string;
  displayName: string;
  headline: string | null;
  specialties: string[];
  region: string | null;
  /** 배지 **유형**만. 강도·발급기관은 상세에서 본다 — 목록에서 정렬 근거로 쓰이지 않게 한다(N-3). */
  badgeTypes: string[];
  placement: Placement;
  /** 재현 가능한 근거 코드만. 자유 문장을 넣으면 검증할 수 없다. */
  rankingBasis: string[];
}

/**
 * 허용된 근거 코드 — **닫힌 집합이다.**
 *
 * 닫아 두는 이유: 코드가 자유 문자열이면 "AI가 추천함" 같은 설명 불가능한 근거가
 * 들어오고, 사용자는 그것을 검증할 방법이 없다. 새 근거가 필요하면 이 배열에 추가하고
 * 그 코드가 **무엇을 보고 결정됐는지** 테스트로 고정해야 한다.
 */
export const RANKING_BASIS_CODES: readonly string[] = [
  "specialty_match",
  "region_match",
  "badge_present",
  "recently_active",
  "promoted_placement",
];

/**
 * 질의와 결과를 비교한 사실(facet)을 근거 코드 배열로 바꾼다.
 *
 * 순서는 고정이다 — 응답 diff 와 스냅샷 테스트가 흔들리지 않게 하려는 것이고,
 * 이 순서가 "중요도"를 뜻하지는 않는다(가중치가 있으면 그게 곧 점수다 → N-3).
 *
 * 모든 facet 이 false 면 **빈 배열**이 나오고 그 결과는 응답에 담을 수 없다
 * (`validateSearchResults` 가 던진다). 즉 "왜 올라왔는지 말할 수 없는 결과는
 * 애초에 결과가 아니다" — 필터링 책임이 검색 모듈(P-150)에 있다는 뜻이다.
 */
export function buildRankingBasis(f: {
  specialtyMatch: boolean;
  regionMatch: boolean;
  hasBadge: boolean;
  recentlyActive: boolean;
  promoted: boolean;
}): string[] {
  const basis: string[] = [];
  if (f.specialtyMatch) basis.push("specialty_match");
  if (f.regionMatch) basis.push("region_match");
  if (f.hasBadge) basis.push("badge_present");
  if (f.recentlyActive) basis.push("recently_active");
  // N-15: 유료 노출은 placement 플래그만으로 끝내지 않고 근거에도 적는다 —
  // 근거 목록만 읽어도 "이건 돈을 낸 자리"임이 드러나야 한다.
  if (f.promoted) basis.push("promoted_placement");
  return basis;
}

/**
 * 응답 직전 게이트. 통과하면 모든 결과가 설명 가능하다.
 *
 * 세 가지만 본다 — 전부 "공개 약속을 지켰는가"에 대한 질문이다:
 *   1. 근거가 비었다            → 왜 올라왔는지 말할 수 없다
 *   2. 집합 밖 코드가 있다      → 사용자가 검증할 수 없는 근거다
 *   3. promoted 인데 근거에 없다 → 유료 노출을 숨긴 것이다 (N-15 위반)
 */
export function validateSearchResults(rs: readonly SearchResult[]): void {
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    // noUncheckedIndexedAccess: 인덱싱 결과는 undefined 일 수 있다.
    if (!r) continue;

    if (!Array.isArray(r.rankingBasis) || r.rankingBasis.length === 0) {
      throw new Error(`검색 결과에 랭킹 근거가 없다 (N-15): index=${i} slug=${r.slug}`);
    }

    for (const code of r.rankingBasis) {
      if (!RANKING_BASIS_CODES.includes(code)) {
        throw new Error(`알 수 없는 랭킹 근거 코드 (N-15): index=${i} code=${code}`);
      }
    }

    if (r.placement === "promoted" && !r.rankingBasis.includes("promoted_placement")) {
      throw new Error(`유료 노출이 근거에 표시되지 않았다 (N-15): index=${i} slug=${r.slug}`);
    }
  }
}
