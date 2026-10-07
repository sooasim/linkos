import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "mobile-safari-size", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm --filter @linkos/web start -p ${port}`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    env: { AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-only-secret-not-for-production-use", OTP_DEV_ECHO: "1", RATE_LIMIT_DISABLED: "1", APP_ORIGIN: `http://localhost:${port}`, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos", CREDENTIALS_KEY: process.env.CREDENTIALS_KEY ?? Buffer.alloc(32, 9).toString("base64") },
  },
});
