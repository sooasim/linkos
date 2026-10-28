/**
 * P-152 광고·유료 노출 구분 · P-153 랭킹 근거 공개
 *
 * 전략 §2 의 N-15 를 지키는 테스트다. 깨지면 "설명 가능한 노출"이라는 약속이 깨진 것이다.
 * 이 파일이 지키려는 것은 두 문장이다 (모듈명세 M11 수용기준):
 *   1. 왜 올라왔는지 말할 수 없는 결과는 응답에 담기지 않는다.
 *   2. 돈을 낸 자리는 organic 처럼 보일 수 없다.
 */

import { describe, expect, it } from "vitest";
import { RANKING_BASIS_CODES, type SearchResult, buildRankingBasis, validateSearchResults } from "../src/search";

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    profileId: "p1",
    slug: "kim",
    displayName: "김영업",
    headline: "의료기기 유통",
    specialties: ["의료기기"],
    region: "서울",
    badgeTypes: ["affiliation"],
    placement: "organic",
    rankingBasis: ["specialty_match"],
    ...over,
  };
}

/** facet 이름 → 그 facet 이 만들어야 하는 근거 코드. 순서가 곧 `buildRankingBasis` 의 출력 순서다. */
const FACET_CODE = {
  specialtyMatch: "specialty_match",
  regionMatch: "region_match",
  hasBadge: "badge_present",
  recentlyActive: "recently_active",
  promoted: "promoted_placement",
} as const;

const FACET_KEYS = ["specialtyMatch", "regionMatch", "hasBadge", "recentlyActive", "promoted"] as const;
type FacetKey = (typeof FACET_KEYS)[number];
type Facets = Record<FacetKey, boolean>;

/** 5개 facet 의 모든 조합(32가지)을 만든다. 전수로 도는 이유: 조합 하나에만 구멍이 있어도 N-15 는 뚫린다. */
function facetsFromMask(mask: number): Facets {
  const f = { specialtyMatch: false, regionMatch: false, hasBadge: false, recentlyActive: false, promoted: false };
  FACET_KEYS.forEach((k, bit) => {
    f[k] = (mask & (1 << bit)) !== 0;
  });
  return f;
}

function expectedBasis(f: Facets): string[] {
  return FACET_KEYS.filter((k) => f[k]).map((k) => FACET_CODE[k]);
}

describe("P-153 / N-15: 근거 없는 결과는 응답에 담을 수 없다 (모듈명세 M11)", () => {
  it("rankingBasis 가 빈 배열이면 던진다 — '왜 올라왔는지'를 말할 수 없는 결과다", () => {
    expect(() => validateSearchResults([result({ rankingBasis: [] })])).toThrow(/N-15/);
  });

  it("rankingBasis 가 배열이 아니면 던진다 (자유 문장 하나를 넣는 실수)", () => {
    const broken = result({ rankingBasis: "specialty_match" as unknown as string[] });
    expect(() => validateSearchResults([broken])).toThrow(/N-15/);
  });

  it("허용 집합 밖의 코드가 섞이면 던진다 — 사용자가 검증할 수 없는 근거를 막는다", () => {
    expect(() => validateSearchResults([result({ rankingBasis: ["ai_recommended"] })])).toThrow(/N-15/);
    // 정상 코드와 섞여 있어도 잡아낸다. 하나라도 검증 불가하면 그 결과는 설명 가능하지 않다.
    expect(() => validateSearchResults([result({ rankingBasis: ["specialty_match", "paid_boost"] })])).toThrow(/N-15/);
  });

  it("빈 문자열·대문자·공백 패딩도 집합 밖 코드로 본다", () => {
    for (const bad of ["", " specialty_match", "SPECIALTY_MATCH", "specialty_match "]) {
      expect(() => validateSearchResults([result({ rankingBasis: [bad] })]), `"${bad}" 가 통과했다`).toThrow(/N-15/);
    }
  });

  it("여러 결과 중 하나만 어겨도 응답 전체가 막힌다", () => {
    const rs = [result({ slug: "a" }), result({ slug: "b", rankingBasis: [] }), result({ slug: "c" })];
    // 나쁜 결과 하나를 조용히 떨어뜨리고 나머지를 내보내는 동작이 아니다 — 조립 단계에서 터져야 한다.
    expect(() => validateSearchResults(rs)).toThrow(/slug=b/);
  });

  it("정상 결과는 통과한다", () => {
    expect(() => validateSearchResults([result(), result({ slug: "lee", rankingBasis: ["region_match", "badge_present"] })])).not.toThrow();
  });

  it("빈 결과 목록은 통과한다 — '검색 결과 없음'은 위반이 아니다", () => {
    expect(() => validateSearchResults([])).not.toThrow();
  });
});

describe("P-152 / N-15: 유료 노출은 organic 으로 위장할 수 없다", () => {
  it("placement=promoted 인데 근거에 promoted_placement 가 없으면 던진다", () => {
    const hidden = result({ placement: "promoted", rankingBasis: ["specialty_match", "region_match"] });
    expect(() => validateSearchResults([hidden])).toThrow(/N-15/);
  });

  it("promoted 인데 근거가 비어 있어도 던진다", () => {
    expect(() => validateSearchResults([result({ placement: "promoted", rankingBasis: [] })])).toThrow(/N-15/);
  });

  it("promoted 가 근거에 적혀 있으면 통과한다 — 근거 목록만 읽어도 유료임이 드러난다", () => {
    const shown = result({ placement: "promoted", rankingBasis: ["specialty_match", "promoted_placement"] });
    expect(() => validateSearchResults([shown])).not.toThrow();
    expect(shown.rankingBasis).toContain("promoted_placement");
  });

  it("promoted_placement 단독 근거도 통과한다 — '돈을 낸 자리'는 그 자체로 공개 가능한 근거다", () => {
    expect(() => validateSearchResults([result({ placement: "promoted", rankingBasis: ["promoted_placement"] })])).not.toThrow();
  });

  it("placement 는 organic|promoted 두 값뿐이고 둘 다 조립을 통과한다 (P-152 수용기준)", () => {
    for (const placement of ["organic", "promoted"] as const) {
      const r = result({ placement, rankingBasis: placement === "promoted" ? ["promoted_placement"] : ["specialty_match"] });
      expect(() => validateSearchResults([r]), `${placement} 가 막혔다`).not.toThrow();
      expect(r.placement).toBe(placement);
    }
  });
});

describe("P-153: 허용 근거 코드는 닫힌 집합이다", () => {
  it("코드 목록이 정확히 5개로 고정돼 있다 — 추가하려면 이 테스트를 같이 고쳐야 한다", () => {
    expect([...RANKING_BASIS_CODES]).toEqual([
      "specialty_match",
      "region_match",
      "badge_present",
      "recently_active",
      "promoted_placement",
    ]);
  });

  it("점수·가중치를 뜻하는 코드가 없다 (N-3 — 단일 신뢰점수 금지)", () => {
    for (const code of RANKING_BASIS_CODES) {
      expect(code, `${code} 가 점수처럼 읽힌다`).not.toMatch(/score|rank_value|weight|trust/i);
    }
  });
});

describe("P-153: buildRankingBasis 는 facet 조합을 근거 코드로 바꾼다", () => {
  it("32가지 facet 조합 전부에서 올바른 코드와 고정된 순서를 만든다", () => {
    for (let mask = 0; mask < 1 << FACET_KEYS.length; mask++) {
      const f = facetsFromMask(mask);
      // toEqual 로 비교하므로 membership 과 **순서**를 동시에 고정한다
      // (순서가 흔들리면 응답 diff·스냅샷이 무의미해진다).
      expect(buildRankingBasis(f), `mask=${mask}`).toEqual(expectedBasis(f));
    }
  });

  it("어떤 조합에서도 집합 밖 코드를 만들지 않는다", () => {
    for (let mask = 0; mask < 1 << FACET_KEYS.length; mask++) {
      for (const code of buildRankingBasis(facetsFromMask(mask))) {
        expect(RANKING_BASIS_CODES.includes(code), `mask=${mask} code=${code}`).toBe(true);
      }
    }
  });

  it("facet 하나만 참이면 그 코드 하나만 나온다", () => {
    for (const key of FACET_KEYS) {
      const f = facetsFromMask(0);
      f[key] = true;
      expect(buildRankingBasis(f)).toEqual([FACET_CODE[key]]);
    }
  });

  it("promoted 가 참이면 promoted_placement 가 반드시 들어간다 (16가지 조합 전수)", () => {
    for (let mask = 0; mask < 1 << FACET_KEYS.length; mask++) {
      const f = facetsFromMask(mask);
      if (!f.promoted) continue;
      expect(buildRankingBasis(f), `mask=${mask}`).toContain("promoted_placement");
    }
  });

  it("promoted 가 거짓이면 promoted_placement 가 들어가지 않는다 — organic 을 유료로 오표기하지 않는다", () => {
    for (let mask = 0; mask < 1 << FACET_KEYS.length; mask++) {
      const f = facetsFromMask(mask);
      if (f.promoted) continue;
      expect(buildRankingBasis(f), `mask=${mask}`).not.toContain("promoted_placement");
    }
  });
});

describe("P-153 / N-15: 모든 facet 이 거짓인 조합은 응답에 담길 수 없다", () => {
  it("facet 이 전부 거짓이면 근거는 빈 배열이다", () => {
    expect(buildRankingBasis(facetsFromMask(0))).toEqual([]);
  });

  it("그 빈 근거를 결과에 담으면 validateSearchResults 가 던진다 — 이 조합이 실제 위험 경로다", () => {
    // 질의와 아무 facet 도 일치하지 않은 프로필을 결과에 섞으면 여기서 배포 전에 터진다.
    // 즉 "그런 결과를 애초에 넣지 않을" 책임이 검색 모듈(P-150)에 있다는 뜻이다.
    const basis = buildRankingBasis(facetsFromMask(0));
    expect(() => validateSearchResults([result({ rankingBasis: basis })])).toThrow(/N-15/);
    expect(() => validateSearchResults([result({ placement: "promoted", rankingBasis: basis })])).toThrow(/N-15/);
  });

  it("facet 이 하나라도 참이면 그 결과는 조립을 통과한다 (31가지 조합 전수)", () => {
    for (let mask = 1; mask < 1 << FACET_KEYS.length; mask++) {
      const f = facetsFromMask(mask);
      const basis = buildRankingBasis(f);
      const placement = f.promoted ? "promoted" : "organic";
      expect(() => validateSearchResults([result({ placement, rankingBasis: basis })]), `mask=${mask}`).not.toThrow();
    }
  });

  it("promoted 자리인데 근거를 promoted facet 없이 만들면 전수로 막힌다", () => {
    // 유료 노출을 "일반 결과 근거"로만 설명하려는 시도. 조합을 바꿔도 통과 경로가 없어야 한다.
    for (let mask = 1; mask < 1 << FACET_KEYS.length; mask++) {
      const f = facetsFromMask(mask);
      if (f.promoted) continue;
      const basis = buildRankingBasis(f);
      expect(() => validateSearchResults([result({ placement: "promoted", rankingBasis: basis })]), `mask=${mask}`).toThrow(/N-15/);
    }
  });
});

describe("P-153: validateSearchResults 의 현재 한계 (문서화 목적)", () => {
  it("organic 인데 promoted_placement 를 적은 결과는 막지 않는다 — 반대 방향만 검사한다", () => {
    // 위험한 방향(유료를 숨김)은 막지만, 반대 방향(일반 결과를 유료로 표기)은 통과한다.
    // 사용자에게 손해가 되는 쪽이 아니어서 지금은 허용이지만, UI 가 이 조합을 유료 배지로
    // 그리면 오표기가 된다. 동작이 바뀌면 이 테스트가 먼저 깨져 결정을 드러낸다.
    expect(() => validateSearchResults([result({ placement: "organic", rankingBasis: ["promoted_placement"] })])).not.toThrow();
  });

  it("같은 근거 코드가 중복돼도 막지 않는다", () => {
    expect(() => validateSearchResults([result({ rankingBasis: ["specialty_match", "specialty_match"] })])).not.toThrow();
  });

  it("배열에 비어 있는 칸(undefined)이 있으면 검사를 건너뛴다", () => {
    // 구현이 `if (!r) continue;` 로 넘긴다. 길이만 맞춰 만든 배열(`new Array(n)`)이나
    // 필터 실수로 들어온 null 칸은 근거 검사 없이 통과한다 — 보고서에 적어 둔 구멍이다.
    const holey = [undefined as unknown as SearchResult];
    expect(() => validateSearchResults(holey)).not.toThrow();
  });
});
