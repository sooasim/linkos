import { defineConfig } from "@playwright/test";
import { buildEnvironments } from "./tests/matrix/environments";

// 100-environment browser simulation (docs/QA_MATRIX.md). One compact critical journey per environment.
// Shard in CI with `pnpm matrix --shard=1/4` etc.
const port = Number(process.env.E2E_PORT ?? 3401);
const envs = buildEnvironments();

export default defineConfig({
  testDir: "tests/matrix",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: Number(process.env.MATRIX_WORKERS ?? 4),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"], ["json", { outputFile: "test-results/matrix.json" }]] : [["list"], ["json", { outputFile: "test-results/matrix.json" }]],
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: envs.map((e) => ({ name: e.id, use: e.use, metadata: { network: e.network, kind: e.kind, device: e.device } })),
  webServer: {
    command: `pnpm --filter @linkos/web start -p ${port}`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      AUTH_SECRET: process.env.AUTH_SECRET ?? "test",
      OTP_DEV_ECHO: "1",
      RATE_LIMIT_DISABLED: "1",
      BILLING_ENFORCEMENT: "off",
      APP_ORIGIN: `http://localhost:${port}`,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos_test_q",
      CREDENTIALS_KEY: process.env.CREDENTIALS_KEY ?? Buffer.alloc(32, 7).toString("base64"),
    },
  },
});
