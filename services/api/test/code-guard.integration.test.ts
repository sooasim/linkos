// F-045 4자리 교환 코드: 발급 형식, 만료 후 재사용, "틀린 코드" 추측 제한(IP별), 전체 토큰 경로는 제한 없음.
// Rate limiting is ON in this file (each vitest file runs in its own process), so every case uses its own IP.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test";
delete process.env.RATE_LIMIT_DISABLED;
process.env.APP_ORIGIN = "https://linkos.test";

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { card, handoff, identity, closePool, q } = api;

const ctx = (userId: string | null, ip: string) => ({ userId, ip, userAgent: "Mozilla/5.0 (iPhone) Safari/605", requestId: "t" });
const consents = (["terms", "privacy", "age_14"] as const).map((type) => ({ type, granted: true }));
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function sender() {
  const email = `codeguard${uniq()}@linkos.test`;
  const reqIp = ip();
  const { devCode } = await identity.requestOtp(ctx(null, reqIp), email);
  const { user } = await identity.verifyOtp(ctx(null, reqIp), email, devCode!, consents);
  await card.saveProfile(ctx(user.id, reqIp), {
    name: "코드 테스트", company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
    theme: "ink", matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [],
  } as never);
  return user.id as string;
}

/** 4-digit codes that are NOT live right now (so a "wrong code" is really wrong, even with other tests' sessions in the DB). */
async function deadCodes(n: number): Promise<string[]> {
  const live = new Set((await q<{ short_code: string }>("SELECT short_code FROM exchange_sessions WHERE short_code IS NOT NULL AND short_code_expires_at > now()")).map((r) => r.short_code));
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 10_000; i++) {
    const c = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
    if (!live.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await closePool();
});

describe("F-045 4-digit exchange code", () => {
  it("issues a 4-digit code that opens the guest landing in any typed form", async () => {
    const uid = await sender();
    const s = await handoff.createExchangeSession(ctx(uid, ip()), { capabilities: {}, group: false, context: {} });
    expect(s.shortCode).toMatch(/^\d{4}$/);
    expect(s.shortUrl).toBe(`https://linkos.test/c/${s.shortCode}`);
    const guest = ip();
    for (const typed of [s.shortCode!, `${s.shortCode!.slice(0, 2)} ${s.shortCode!.slice(2)}`, `${s.shortCode!.slice(0, 2)}-${s.shortCode!.slice(2)}`]) {
      const landing = await handoff.openGuestLanding(typed, ctx(null, guest), "anon");
      expect(landing.sessionId).toBe(s.sessionId);
    }
  });

  it("blocks an IP after 8 wrong codes in 10 minutes — even its next correct code — while other IPs and full tokens still work", async () => {
    const uid = await sender();
    const s = await handoff.createExchangeSession(ctx(uid, ip()), { capabilities: {}, group: false, context: {} });
    const attacker = ip();
    for (const wrong of await deadCodes(8)) {
      await expect(handoff.openGuestLanding(wrong, ctx(null, attacker), "x")).rejects.toMatchObject({ status: 404 });
    }
    // 9th attempt from the same IP is refused before any lookup, even with the right code
    await expect(handoff.openGuestLanding(s.shortCode!, ctx(null, attacker), "x")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(handoff.getGuestSessionStatus(s.shortCode!, ctx(null, attacker))).rejects.toMatchObject({ status: 429 });
    // a different person is unaffected
    expect((await handoff.openGuestLanding(s.shortCode!, ctx(null, ip()), "y")).sessionId).toBe(s.sessionId);
    // the unguessable full token is not subject to the code guard
    expect((await handoff.openGuestLanding(s.token, ctx(null, attacker), "z")).sessionId).toBe(s.sessionId);
  });

  it("correct codes do not count against the guard", async () => {
    const uid = await sender();
    const guest = ip();
    for (let i = 0; i < 10; i++) {
      const s = await handoff.createExchangeSession(ctx(uid, ip()), { capabilities: {}, group: false, context: {} });
      expect((await handoff.openGuestLanding(s.shortCode!, ctx(null, guest), "ok")).sessionId).toBe(s.sessionId);
    }
  });

  it("an expired code stops working immediately", async () => {
    const uid = await sender();
    const s = await handoff.createExchangeSession(ctx(uid, ip()), { capabilities: {}, group: false, context: {} });
    await q("UPDATE exchange_sessions SET short_code_expires_at = now() - interval '1 minute' WHERE id=$1", [s.sessionId]);
    await expect(handoff.openGuestLanding(s.shortCode!, ctx(null, ip()), "late")).rejects.toMatchObject({ status: 404 });
  });
});
