// /api/v1/health 가 알려주는 빌드 식별자. DB 가 필요 없는 순수 환경변수 해석이라 단위테스트로 덮는다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInfo } from "../src/lib/platform";

const KEYS = ["APP_VERSION", "APP_REVISION", "RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "GITHUB_SHA"] as const;
const SHA = "98077e4b11699c63e551abd35df397832e2f7fa9";

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildInfo", () => {
  it("아무것도 설정되지 않으면 버전만 돌려주고 revision 은 null 이다", () => {
    expect(buildInfo()).toEqual({ version: "1.0.0", revision: null });
  });

  it("플랫폼이 넣어 준 커밋 SHA 를 짧은 형태(7자)로 노출한다", () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    expect(buildInfo().revision).toBe("98077e4");
  });

  it("APP_REVISION 이 플랫폼 변수보다 우선한다 (도커 빌드 인자로 직접 지정하는 경우)", () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    process.env.APP_REVISION = "deadbeefcafe";
    expect(buildInfo().revision).toBe("deadbee");
  });

  it("Render · Vercel · GitHub Actions 중 어디에서 와도 읽는다", () => {
    for (const k of ["RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "GITHUB_SHA"] as const) {
      for (const other of KEYS) delete process.env[other];
      process.env[k] = SHA;
      expect(buildInfo().revision, k).toBe("98077e4");
    }
  });

  it("APP_VERSION 은 그대로 전달한다", () => {
    process.env.APP_VERSION = "2026.10.1";
    expect(buildInfo().version).toBe("2026.10.1");
  });

  it("이미 짧은 SHA 를 넣어도 잘라내지 않는다", () => {
    process.env.APP_REVISION = "abc1234";
    expect(buildInfo().revision).toBe("abc1234");
  });
});
