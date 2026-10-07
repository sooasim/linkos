import { defineConfig } from "@playwright/test";

// 100-scenario suite (tests/scenarios). Runs against a production build.
const port = Number(process.env.E2E_PORT ?? 3100);
export default defineConfig({
  testDir: "tests/scenarios",
  timeout: 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { locale: "ko-KR", baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm --filter @linkos/web start -p ${port}`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-only-secret-not-for-production-use",
      OTP_DEV_ECHO: "1",
      RATE_LIMIT_DISABLED: "1",
      APP_ORIGIN: `http://localhost:${port}`,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos",
    },
  },
});
