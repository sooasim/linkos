// F-045 / F-171 4자리 교환 코드 추측 방어의 판단 규칙.
import { describe, expect, it } from "vitest";
import { type CodeGuardLimits, decideCodeLookup } from "../src/codeGuard";

const L: CodeGuardLimits = {
  ipWindow: { limit: 8, sec: 600 },
  ipDay: { limit: 30, sec: 86_400 },
  global: { limit: 3000, sec: 600, strictIpLimit: 1 },
};

const counts = (ipFails: number, ipDayFails = ipFails, globalFails = 0) => ({ ipFails, ipDayFails, globalFails });

describe("F-045 코드 추측 방어", () => {
  it("평시에는 IP당 한도 직전까지 통과시킨다", () => {
    for (let n = 0; n < L.ipWindow.limit; n++) {
      expect(decideCodeLookup(counts(n), L)).toEqual({ allow: true, underPressure: false });
    }
  });

  it("IP 짧은 창 한도에 닿으면 막고, 창 길이만큼 기다리라고 알려준다", () => {
    expect(decideCodeLookup(counts(L.ipWindow.limit), L)).toEqual({
      allow: false, reason: "ip_window", retryAfterSec: 600, underPressure: false,
    });
  });

  it("하루 한도는 짧은 창이 비어 있어도 막는다", () => {
    expect(decideCodeLookup({ ipFails: 0, ipDayFails: L.ipDay.limit, globalFails: 0 }, L)).toEqual({
      allow: false, reason: "ip_day", retryAfterSec: 60, underPressure: false,
    });
  });

  it("더 구체적인 이유(IP 짧은 창)를 하루 한도보다 먼저 돌려준다", () => {
    const d = decideCodeLookup({ ipFails: 99, ipDayFails: 99, globalFails: 0 }, L);
    expect(d).toMatchObject({ allow: false, reason: "ip_window" });
  });

  // 이 파일의 핵심: 전역 압력이 전면 차단이 되면 안 된다.
  describe("전역 압력 (분산 추측)", () => {
    const pressure = L.global.limit;

    it("한 번도 틀리지 않은 IP 는 전역 압력 중에도 통과한다 — self-DoS 를 만들지 않는다", () => {
      expect(decideCodeLookup(counts(0, 0, pressure), L)).toEqual({ allow: true, underPressure: true });
      expect(decideCodeLookup(counts(0, 0, pressure * 100), L)).toEqual({ allow: true, underPressure: true });
    });

    it("이미 틀린 적 있는 IP 는 전역 압력 중에 즉시 막힌다 (평시 8회 예산이 1회로 줄어든다)", () => {
      expect(decideCodeLookup(counts(1, 1, pressure), L)).toEqual({
        allow: false, reason: "global_pressure", retryAfterSec: 600, underPressure: true,
      });
      // 같은 상태가 평시였다면 통과했어야 한다
      expect(decideCodeLookup(counts(1, 1, 0), L)).toEqual({ allow: true, underPressure: false });
    });

    it("압력이 한도 바로 아래면 평소 규칙 그대로다", () => {
      expect(decideCodeLookup(counts(1, 1, pressure - 1), L)).toEqual({ allow: true, underPressure: false });
    });

    it("strictIpLimit 을 올리면 압력 중 허용 폭이 그만큼 넓어진다", () => {
      const lenient: CodeGuardLimits = { ...L, global: { ...L.global, strictIpLimit: 3 } };
      expect(decideCodeLookup(counts(2, 2, pressure), lenient)).toMatchObject({ allow: true, underPressure: true });
      expect(decideCodeLookup(counts(3, 3, pressure), lenient)).toMatchObject({ allow: false, reason: "global_pressure" });
    });

    it("압력 중이라도 IP 짧은 창 한도가 우선이라 이유가 뒤섞이지 않는다", () => {
      expect(decideCodeLookup(counts(L.ipWindow.limit, L.ipWindow.limit, pressure), L)).toMatchObject({
        allow: false, reason: "ip_window", underPressure: true,
      });
    });
  });

  it("정상 사용자(한 번에 맞히는 사람)는 어떤 전역 상태에서도 막히지 않는다", () => {
    for (const globalFails of [0, 1, L.global.limit - 1, L.global.limit, 1_000_000]) {
      expect(decideCodeLookup({ ipFails: 0, ipDayFails: 0, globalFails }, L).allow).toBe(true);
    }
  });
});
