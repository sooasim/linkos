/**
 * P-141 요금제 한도 적용 — 모듈명세 M10.
 *
 * 전략 §2 의 **N-2** 를 지키는 테스트다 (보안정책 §4.10).
 * 수용기준: "한도는 기능 접근만 제한한다. 배지 발급에는 영향을 주지 않는다."
 * 그래서 이 파일의 첫 describe 는 함수 동작이 아니라 **타입의 키 집합**을 검사한다 —
 * 누가 "Pro 전용 배지 슬롯"을 만들려고 `badgeSlots` 를 추가하면 거기서 터진다.
 */

import { describe, expect, it } from "vitest";
import { type PlanLimits, withinLimit } from "../src/plans";

/**
 * `Required<PlanLimits>` 로 못 박았기 때문에 **키가 하나라도 늘거나 빠지면 컴파일이 깨진다.**
 * 즉 아래 런타임 키 검사는 항상 타입의 전체 키 집합을 본다.
 */
const PROBE: Required<PlanLimits> = {
  offers: 5,
  blocks: 10,
  customDomain: false,
  booking: true,
  analyticsDays: 30,
  teamSeats: 3,
};

const KEYS = Object.keys(PROBE);

describe("P-141 / N-2: PlanLimits 에 배지·검증 관련 키가 없다 (보안정책 §4.10)", () => {
  it("키 이름에 badge/verif/trust/score/proof/credential 이 들어간 것이 하나도 없다", () => {
    const forbiddenParts = ["badge", "verif", "trust", "score", "proof", "credential", "review"];
    for (const key of KEYS) {
      for (const part of forbiddenParts) {
        expect(key.toLowerCase().includes(part), `요금제 한도에 '${key}' 가 생겼다 — N-2 위반`).toBe(false);
      }
    }
  });

  it("구체적 금지 이름을 명시적으로 단정한다", () => {
    for (const name of [
      "badge",
      "badges",
      "badgeSlots",
      "verified",
      "verifiedBadges",
      "verification",
      "verificationPriority",
      "prioritySupportForReview",
      "trustScore",
    ]) {
      expect(KEYS, `${name} 가 요금제 한도에 들어왔다`).not.toContain(name);
    }
  });

  it("한도 키는 노출 공간·편의 기능·보관 기간·좌석뿐이다", () => {
    expect([...KEYS].sort()).toEqual(["analyticsDays", "blocks", "booking", "customDomain", "offers", "teamSeats"]);
  });

  it("배지 관련 키로 한도를 물어도 통과하지 않는다 (fail-closed)", () => {
    // 요금제로 배지를 사는 경로가 실수로 생기더라도 한도 체크가 허용을 내주지 않는다.
    for (const bogus of ["badges", "verifiedBadges", "trustScore"]) {
      expect(withinLimit(PROBE, bogus as keyof PlanLimits, 0), bogus).toBe(false);
    }
  });
});

describe("P-141: 수치 한도의 경계", () => {
  const limits: PlanLimits = { offers: 3, blocks: 0, customDomain: false, booking: false, analyticsDays: 7 };

  it("current < limit 이면 허용한다", () => {
    expect(withinLimit(limits, "offers", 0)).toBe(true);
    expect(withinLimit(limits, "offers", 2)).toBe(true);
  });

  it("경계: current === limit 이면 거부한다 — 호출부는 생성 전에 현재 개수를 넣는다", () => {
    expect(withinLimit(limits, "offers", 3)).toBe(false);
  });

  it("current > limit 이면 거부한다", () => {
    expect(withinLimit(limits, "offers", 4)).toBe(false);
    expect(withinLimit(limits, "offers", 9999)).toBe(false);
  });

  it("한도 0 은 '이 요금제에서는 쓸 수 없다'로 작동한다", () => {
    expect(withinLimit(limits, "blocks", 0)).toBe(false);
  });

  it("음수 한도도 거부로 귀결된다 (잘못된 플랜 레코드가 기능을 열지 않는다)", () => {
    const broken: PlanLimits = { ...limits, offers: -1 };
    expect(withinLimit(broken, "offers", 0)).toBe(false);
    expect(withinLimit(broken, "offers", 1)).toBe(false);
  });

  it("한도가 NaN·Infinity 면 거부한다 — 깨진 jsonb 가 무제한이 되지 않는다", () => {
    expect(withinLimit({ ...limits, offers: Number.NaN }, "offers", 0)).toBe(false);
    expect(withinLimit({ ...limits, offers: Number.POSITIVE_INFINITY }, "offers", 0)).toBe(false);
  });

  it("한도가 숫자가 아니면 거부한다 (plans.limits jsonb 는 무엇이든 담을 수 있다)", () => {
    const broken = { ...limits, offers: "3" } as unknown as PlanLimits;
    expect(withinLimit(broken, "offers", 0)).toBe(false);
    const nulled = { ...limits, offers: null } as unknown as PlanLimits;
    expect(withinLimit(nulled, "offers", 0)).toBe(false);
  });

  it("current 가 NaN·Infinity 면 거부한다", () => {
    expect(withinLimit(limits, "offers", Number.NaN)).toBe(false);
    expect(withinLimit(limits, "offers", Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("분석 보관 기간도 같은 규칙을 쓴다", () => {
    expect(withinLimit(limits, "analyticsDays", 6)).toBe(true);
    expect(withinLimit(limits, "analyticsDays", 7)).toBe(false);
  });
});

describe("P-141: 불린 기능 플래그와 없는 키", () => {
  const limits: PlanLimits = { offers: 3, blocks: 5, customDomain: false, booking: true, analyticsDays: 30 };

  it("플래그가 false 면 current 와 무관하게 거부한다", () => {
    for (const current of [0, 1, 999, -1, Number.NaN]) {
      expect(withinLimit(limits, "customDomain", current), String(current)).toBe(false);
    }
  });

  it("플래그가 true 면 current 와 무관하게 허용한다 — 개수 한도가 아니다", () => {
    for (const current of [0, 1, 999]) {
      expect(withinLimit(limits, "booking", current), String(current)).toBe(true);
    }
  });

  it("teamSeats 가 정의되지 않은 요금제는 거부한다 (0 과 구분되는 '기능 없음')", () => {
    expect(limits.teamSeats).toBeUndefined();
    expect(withinLimit(limits, "teamSeats", 0)).toBe(false);
    expect(withinLimit(limits, "teamSeats", 1)).toBe(false);
  });

  it("teamSeats 가 정의된 요금제는 수치 한도로 작동한다", () => {
    const team: PlanLimits = { ...limits, teamSeats: 2 };
    expect(withinLimit(team, "teamSeats", 1)).toBe(true);
    expect(withinLimit(team, "teamSeats", 2)).toBe(false);
  });

  it("teamSeats 가 0 이면 좌석이 없다 — undefined 와 결과는 같지만 의미가 다르다", () => {
    expect(withinLimit({ ...limits, teamSeats: 0 }, "teamSeats", 0)).toBe(false);
  });
});

describe("P-140: 한도 값은 코드 상수가 아니라 플랜 레코드에서 온다", () => {
  it("plans.ts 가 Free/Pro/Business 숫자를 export 하지 않는다", async () => {
    // 숫자를 코드에 박으면 요금제 변경이 배포를 요구한다 (P-140 수용기준).
    const mod = (await import("../src/plans")) as Record<string, unknown>;
    const exported = Object.entries(mod).filter(([k]) => k !== "default" && !k.startsWith("_"));
    expect(exported.length).toBeGreaterThan(0);
    for (const [k, v] of exported) {
      expect(typeof v, `${k} 가 값 상수로 export 됐다 — 숫자는 plans 레코드에서 와야 한다`).toBe("function");
    }
    expect(exported.map(([k]) => k)).toContain("withinLimit");
  });
});
