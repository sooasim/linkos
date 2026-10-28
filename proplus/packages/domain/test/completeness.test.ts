/**
 * P-032 프로필 완성도 안내 — ADR-003 / 기획서 §13.
 *
 * 전략 §2 의 **N-3** 을 지키는 테스트다. 수용기준은 두 가지다:
 *   "보조 안내로만 사용하고 공개 DTO 에 포함하지 않는다" + "신뢰점수로 오인될 표현 금지".
 * 그래서 이 파일은 비율 계산뿐 아니라 **반환 객체에 점수로 읽힐 키가 없다는 것**과
 * `publicDto.ts` 의 `NEVER_PUBLIC_KEYS` 가 'completeness' 를 막고 있다는 것을 함께 단정한다.
 */

import { describe, expect, it } from "vitest";
import {
  COMPLETENESS_ITEMS,
  COMPLETENESS_LABEL_KO,
  type CompletenessInput,
  profileCompleteness,
} from "../src/completeness";
import { NEVER_PUBLIC_KEYS, assertNoPrivateKeys, findPrivateKey } from "../src/publicDto";

/** 비트 하나가 COMPLETENESS_ITEMS 의 한 항목이다 (순서 동일). */
function inputFromMask(mask: number): CompletenessInput {
  return {
    hasHeadline: (mask & 1) !== 0,
    hasBio: (mask & 2) !== 0,
    specialtyCount: (mask & 4) !== 0 ? 3 : 0,
    badgeCount: (mask & 8) !== 0 ? 1 : 0,
    offerCount: (mask & 16) !== 0 ? 2 : 0,
    hasCta: (mask & 32) !== 0,
  };
}

const EMPTY = inputFromMask(0);
const FULL = inputFromMask(63);

describe("P-032: 전수 — 64개 입력 조합의 비율과 빠진 항목", () => {
  it("percent 는 항상 0~100 이고 '채운 수/전체' 의 반올림이다", () => {
    for (let mask = 0; mask < 1 << COMPLETENESS_ITEMS.length; mask++) {
      const r = profileCompleteness(inputFromMask(mask));
      const filled = COMPLETENESS_ITEMS.filter((_, idx) => (mask & (1 << idx)) !== 0).length;
      expect(r.percent, `mask=${mask}`).toBe(Math.round((filled / COMPLETENESS_ITEMS.length) * 100));
      expect(r.percent, `mask=${mask}`).toBeGreaterThanOrEqual(0);
      expect(r.percent, `mask=${mask}`).toBeLessThanOrEqual(100);
    }
  });

  it("missing 은 항목 순서를 유지하고 중복이 없다", () => {
    for (let mask = 0; mask < 1 << COMPLETENESS_ITEMS.length; mask++) {
      const r = profileCompleteness(inputFromMask(mask));
      const expectedMissing = COMPLETENESS_ITEMS.filter((_, idx) => (mask & (1 << idx)) === 0);
      expect(r.missing, `mask=${mask}`).toEqual([...expectedMissing]);
      expect(new Set(r.missing).size, `mask=${mask}`).toBe(r.missing.length);
    }
  });

  it("missing 코드는 전수에서 항상 COMPLETENESS_ITEMS 안의 값이다 — 코드가 안정적이다", () => {
    const known = new Set<string>(COMPLETENESS_ITEMS);
    for (let mask = 0; mask < 1 << COMPLETENESS_ITEMS.length; mask++) {
      for (const code of profileCompleteness(inputFromMask(mask)).missing) {
        expect(known.has(code), `알 수 없는 안내 코드: ${code}`).toBe(true);
      }
    }
  });

  it("경계: 전부 비면 0% 이고 여섯 항목이 모두 빠진 것으로 나온다", () => {
    const r = profileCompleteness(EMPTY);
    expect(r.percent).toBe(0);
    expect(r.missing).toEqual([...COMPLETENESS_ITEMS]);
  });

  it("경계: 전부 채우면 100% 이고 빠진 항목이 없다", () => {
    const r = profileCompleteness(FULL);
    expect(r.percent).toBe(100);
    expect(r.missing).toEqual([]);
  });
});

describe("P-032 / N-3: 가중치가 없다 — 가중치가 생기면 그게 점수 모델이다", () => {
  it("배지 1개와 100개의 비율이 같다", () => {
    const one = profileCompleteness({ ...EMPTY, badgeCount: 1 });
    const many = profileCompleteness({ ...EMPTY, badgeCount: 100 });
    expect(many.percent).toBe(one.percent);
    expect(many.missing).toEqual(one.missing);
  });

  it("어떤 한 항목만 채워도 비율이 같다 — 항목 간 서열이 없다", () => {
    const percents = new Set<number>();
    for (let idx = 0; idx < COMPLETENESS_ITEMS.length; idx++) {
      percents.add(profileCompleteness(inputFromMask(1 << idx)).percent);
    }
    expect(percents.size).toBe(1);
  });

  it("검증 강도가 입력에 아예 없다 — 강한 배지가 완성도를 더 올리지 못한다", () => {
    const keys = Object.keys(FULL);
    for (const forbidden of ["method", "verificationMethod", "badgeStrength", "trustScore", "score"]) {
      expect(keys, `${forbidden} 가 입력에 생겼다`).not.toContain(forbidden);
    }
  });
});

describe("P-032: 개수 항목의 경계값", () => {
  it("개수 0 은 빠진 항목이고 1 이상은 채운 항목이다", () => {
    expect(profileCompleteness({ ...EMPTY, specialtyCount: 0 }).missing).toContain("specialties");
    expect(profileCompleteness({ ...EMPTY, specialtyCount: 1 }).missing).not.toContain("specialties");
  });

  it("음수·NaN·Infinity 는 채운 것으로 보지 않는다 (잘못된 집계가 안내를 지우지 않는다)", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = profileCompleteness({ ...EMPTY, offerCount: bad, badgeCount: bad, specialtyCount: bad });
      expect(r.missing, String(bad)).toEqual([...COMPLETENESS_ITEMS]);
      expect(r.percent, String(bad)).toBe(0);
    }
  });

  it("불린 항목은 true 만 채운 것으로 본다", () => {
    const truthy = { ...EMPTY, hasHeadline: "yes" } as unknown as CompletenessInput;
    expect(profileCompleteness(truthy).missing).toContain("headline");
    const missingKey = { ...EMPTY, hasCta: undefined } as unknown as CompletenessInput;
    expect(profileCompleteness(missingKey).missing).toContain("cta");
  });
});

describe("P-032 / N-3: 반환 객체에 점수로 오인될 필드가 없다", () => {
  it("키는 percent·missing 둘뿐이다", () => {
    expect(Object.keys(profileCompleteness(FULL)).sort()).toEqual(["missing", "percent"]);
  });

  it("score·trustScore·rank 같은 키가 전수 입력에서 한 번도 나오지 않는다", () => {
    const forbidden = ["score", "trustScore", "rank", "ranking", "grade", "level", "tier", "rating", "stars"];
    for (let mask = 0; mask < 1 << COMPLETENESS_ITEMS.length; mask++) {
      const keys = Object.keys(profileCompleteness(inputFromMask(mask)));
      for (const f of forbidden) {
        expect(keys, `mask=${mask} 에 ${f} 가 있다`).not.toContain(f);
      }
    }
  });
});

describe("P-032 / N-4: 완성도는 공개 응답에 들어갈 수 없다 (publicDto 와 짝을 이룬다)", () => {
  it("NEVER_PUBLIC_KEYS 에 'completeness' 가 들어 있다", () => {
    expect(NEVER_PUBLIC_KEYS).toContain("completeness");
  });

  it("단일 점수 계열 키도 함께 막혀 있다 (N-3 트립와이어)", () => {
    for (const key of ["trustScore", "score", "ranking"]) {
      expect(NEVER_PUBLIC_KEYS, key).toContain(key);
    }
  });

  it("완성도를 공개 응답에 섞으면 assertNoPrivateKeys 가 던진다", () => {
    const payload = { slug: "hong", completeness: profileCompleteness(FULL) };
    expect(() => assertNoPrivateKeys(payload)).toThrow();
    expect(findPrivateKey(payload)).toBe("$.completeness");
  });

  it("중첩된 자리에 숨겨도 경로째로 잡힌다", () => {
    const payload = { profile: { slug: "hong", workspace: { completeness: profileCompleteness(EMPTY) } } };
    expect(findPrivateKey(payload)).toBe("$.profile.workspace.completeness");
  });

  it("완성도를 빼면 공개 응답으로 통과한다 — 막히는 것은 이 필드 하나다", () => {
    expect(() => assertNoPrivateKeys({ slug: "hong", headline: "의료기기 유통 12년" })).not.toThrow();
  });
});

describe("P-032: 안내 문구는 '무엇을 하면 되는지'로 쓴다 (신뢰점수 어감 금지)", () => {
  it("전수: 모든 항목에 비어 있지 않은 라벨이 있다", () => {
    for (const item of COMPLETENESS_ITEMS) {
      expect(COMPLETENESS_LABEL_KO[item].trim().length, item).toBeGreaterThan(0);
    }
  });

  it("라벨 키 집합이 COMPLETENESS_ITEMS 와 정확히 같다", () => {
    expect(Object.keys(COMPLETENESS_LABEL_KO).sort()).toEqual([...COMPLETENESS_ITEMS].sort());
  });

  it("라벨에 점수·등급·신뢰도 어감의 단어가 없다", () => {
    const forbidden = ["점수", "신뢰도", "등급", "순위", "평점", "레벨", "score", "%"];
    for (const item of COMPLETENESS_ITEMS) {
      const label = COMPLETENESS_LABEL_KO[item];
      for (const word of forbidden) {
        expect(label.includes(word), `${item} 라벨에 '${word}' 가 있다`).toBe(false);
      }
    }
  });
});
