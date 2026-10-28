/**
 * PROPLUS E2E — LINKOS 의 playwright.config.ts 와 분리돼 있다.
 * 다른 앱·다른 포트·다른 DB 를 쓰므로 설정을 공유하면 서로의 서버를 죽인다.
 *
 * 실행: pnpm --filter @proplus/web build && npx playwright test -c proplus/playwright.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PROPLUS_E2E_PORT ?? 4400);
const BASE_URL = process.env.PROPLUS_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // 공개 프로필은 캐시 전략을 쓰므로 테스트 간 간섭을 피하려고 순차 실행한다.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  },
  projects: [
    // 모바일 우선 제품이므로 모바일을 먼저 돌린다 (모듈명세 M02 수용기준: 첫 화면 노출).
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  // 서버는 외부에서 띄운다 (마이그레이션 순서를 테스트가 통제하지 않게 하려는 것).
  // PROPLUS_E2E_BASE_URL 을 주면 이미 떠 있는 서버를 쓴다.
  webServer: process.env.PROPLUS_E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm --filter @proplus/web start",
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
