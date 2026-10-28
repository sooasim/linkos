/**
 * P-012 위험 로그인 탐지 — 새 기기·새 지역 판정 (보안정책 §2 / 전략 §7).
 *
 * 이 파일이 지키는 경계: 첫 로그인은 경보가 아니고, 버전 업데이트는 "새 기기"가 아니며,
 * 모르는 지역을 "새 지역"이라 부르지 않는다. 이 경계가 흔들리면 알림이 노이즈가 되거나
 * 탈취를 놓친다.
 */

import { describe, expect, it } from "vitest";
import { assessLogin, deviceKey, deviceLabel } from "../src/device";

// 실제 UA 표본 (브라우저×OS 조합). 라벨·키 판정이 현실의 문자열에서 맞는지 본다.
const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeWinNewer:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
} as const;

describe("P-012 / P-005: deviceLabel — 사람이 읽는 브라우저·OS", () => {
  it("브라우저×OS 조합을 올바르게 읽는다 (구체적인 것 우선: Edge>Chrome>Safari)", () => {
    expect(deviceLabel(UA.chromeWin)).toBe("Chrome · Windows");
    expect(deviceLabel(UA.edgeWin)).toBe("Edge · Windows"); // Chrome 문자열을 포함해도 Edge 로
    expect(deviceLabel(UA.safariIphone)).toBe("Safari · iPhone"); // Chrome 아니므로 진짜 Safari
    expect(deviceLabel(UA.firefoxMac)).toBe("Firefox · Mac");
    expect(deviceLabel(UA.chromeAndroid)).toBe("Chrome · Android");
  });

  it("빈·없는 UA 는 '알 수 없는 기기'다 (지어내지 않는다)", () => {
    expect(deviceLabel(null)).toBe("알 수 없는 기기");
    expect(deviceLabel("")).toBe("알 수 없는 기기");
    expect(deviceLabel("   ")).toBe("알 수 없는 기기");
  });

  it("알 수 없는 브라우저는 '기타 브라우저', OS 없으면 생략한다", () => {
    expect(deviceLabel("SomeBot/1.0")).toBe("기타 브라우저");
  });
});

describe("P-012: deviceKey — 버전을 뺀 안정 키", () => {
  it("같은 브라우저의 버전만 다르면 같은 키다 — 자동 업데이트가 '새 기기'가 되지 않게", () => {
    expect(deviceKey(UA.chromeWin)).toBe(deviceKey(UA.chromeWinNewer));
    expect(deviceKey(UA.chromeWin)).toBe("chrome/windows");
  });

  it("브라우저나 OS 가 다르면 키가 다르다", () => {
    expect(deviceKey(UA.chromeWin)).not.toBe(deviceKey(UA.edgeWin));
    expect(deviceKey(UA.chromeWin)).not.toBe(deviceKey(UA.chromeAndroid));
  });

  it("빈·없는 UA 는 모두 'unknown' 하나로 모은다 (매번 새 기기로 잡히지 않게)", () => {
    expect(deviceKey(null)).toBe("unknown");
    expect(deviceKey("")).toBe("unknown");
    expect(deviceKey(null)).toBe(deviceKey(""));
  });
});

describe("P-012: assessLogin — 첫 로그인은 경보가 아니다", () => {
  it("이력이 비면 firstLogin 이고 어떤 것도 새것이 아니다 (알림 없음)", () => {
    const r = assessLogin({ userAgent: UA.chromeWin, region: "KR" }, { deviceKeys: [] });
    expect(r).toEqual({ firstLogin: true, newDevice: false, newRegion: false, shouldNotify: false });
  });

  it("알려진 기기로 다시 로그인하면 새것이 없다", () => {
    const r = assessLogin({ userAgent: UA.chromeWinNewer }, { deviceKeys: [deviceKey(UA.chromeWin)] });
    expect(r.newDevice).toBe(false);
    expect(r.shouldNotify).toBe(false);
  });

  it("알려지지 않은 기기는 newDevice=true 이고 알림 대상이다", () => {
    const r = assessLogin({ userAgent: UA.safariIphone }, { deviceKeys: [deviceKey(UA.chromeWin)] });
    expect(r.newDevice).toBe(true);
    expect(r.shouldNotify).toBe(true);
  });
});

describe("P-012: assessLogin — 지역 신호는 수집됐을 때만 켜진다", () => {
  it("새 지역이면 newRegion=true (기기는 알려진 경우에도)", () => {
    const r = assessLogin(
      { userAgent: UA.chromeWin, region: "JP" },
      { deviceKeys: [deviceKey(UA.chromeWin)], regions: ["KR"] },
    );
    expect(r.newDevice).toBe(false);
    expect(r.newRegion).toBe(true);
    expect(r.shouldNotify).toBe(true);
  });

  it("지역을 모르면(null) 새 지역이라 하지 않는다", () => {
    const r = assessLogin(
      { userAgent: UA.safariIphone, region: null },
      { deviceKeys: [deviceKey(UA.chromeWin)], regions: ["KR"] },
    );
    expect(r.newRegion).toBe(false);
    expect(r.newDevice).toBe(true); // 기기 신호는 지역과 무관하게 동작한다
  });

  it("지역 표기의 대소문자·공백 차이는 같은 지역으로 본다", () => {
    const r = assessLogin(
      { userAgent: UA.chromeWin, region: " kr " },
      { deviceKeys: [deviceKey(UA.chromeWin)], regions: ["KR"] },
    );
    expect(r.newRegion).toBe(false);
  });

  it("알려진 지역 집합이 비어 있으면(수집 전) 새 지역 신호를 켜지 않는다", () => {
    const r = assessLogin(
      { userAgent: UA.chromeWin, region: "KR" },
      { deviceKeys: [deviceKey(UA.chromeWin)] },
    );
    expect(r.newRegion).toBe(false);
  });
});
