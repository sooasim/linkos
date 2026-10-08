// Test-server one-click login (render.yaml DEMO_LOGIN=1): off by default, consent-gated, throwaway accounts only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
process.env.RATE_LIMIT_DISABLED = "1";
delete process.env.DEMO_LOGIN;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { identity, closePool, one } = api;
const ctx = { userId: null, ip: "203.0.113.7", userAgent: "Mozilla/5.0 Test", requestId: "t" };
const consents = (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true }));

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  delete process.env.DEMO_LOGIN;
  await closePool();
});

describe("demo login (test server only)", () => {
  it("does not exist unless DEMO_LOGIN=1", async () => {
    expect(identity.demoLoginEnabled()).toBe(false);
    await expect(identity.demoLogin(ctx, consents)).rejects.toMatchObject({ status: 404 });
  });

  it("requires the mandatory consents", async () => {
    process.env.DEMO_LOGIN = "1";
    await expect(identity.demoLogin(ctx, [{ type: "terms", granted: true }])).rejects.toMatchObject({ status: 400, code: "consent_required" });
  });

  it("creates a fresh throwaway account with a session and recorded consents each time", async () => {
    process.env.DEMO_LOGIN = "1";
    const a = await identity.demoLogin(ctx, consents);
    const b = await identity.demoLogin(ctx, consents);
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user.email).toMatch(/^demo-[a-z0-9]+@demo\.linkos\.invalid$/);
    expect(a.sessionToken.length).toBeGreaterThanOrEqual(32);
    const viewer = await identity.resolveSession(a.sessionToken, ctx, false);
    expect(viewer?.userId).toBe(a.user.id);
    const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM consent_records WHERE subject_user_id=$1 AND granted", [a.user.id]);
    expect(n!.n).toBeGreaterThanOrEqual(3);
  });
});
