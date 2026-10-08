// B. Living Card · 공개범위 (S-011 ~ S-020)
import { expect, test } from "@playwright/test";
import { PROFILE, anon, reply, session, signup, withProfile } from "./helpers";

test("S-011 프로필 생성 201, 첫 프로필은 primary + slug", async () => {
  const u = await signup();
  const p = await withProfile(u);
  expect(p.version).toBe(1);
  expect(p.slug).toBeTruthy();
  const { profiles } = await (await u.api.get("/api/v1/profiles")).json();
  expect(profiles[0].is_primary).toBe(true);
});

test("S-012 이름 없는 프로필은 400 validation_failed", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/profiles", { data: { ...PROFILE, name: "  " } });
  expect(r.status()).toBe(400);
  expect((await r.json()).code).toBe("validation_failed");
});

test("S-013 키워드 4개는 거부(3초 카드 최대 3개)", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/profiles", { data: { ...PROFILE, keywords: ["a", "b", "c", "d"] } });
  expect(r.status()).toBe(400);
});

test("S-014 비로그인 공개 페이지는 public 항목만 노출", async ({ page }) => {
  const u = await signup();
  const p = await withProfile(u);
  await page.goto(`/p/${p.slug}`);
  await expect(page.getByText("linkos.test")).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("hong@linkos.test");
  expect(html).not.toContain("010-1111-2222");
  expect(html).not.toContain("PRIVATE-NOTE-XYZ");
});

test("S-015 교환한 상대는 business 항목까지 보고 trusted는 숨김", async () => {
  const s = await signup();
  const p = await withProfile(s);
  const g = await signup();
  await withProfile(g, { name: "게스트" });
  await reply(g.api, (await session(s)).token);
  // sender's contact links the receiver → receiver sees business fields on /p
  const page = await (await g.api.get(`/p/${p.slug}`)).text();
  expect(page).toContain("hong@linkos.test");
  expect(page).not.toContain("010-1111-2222");
});

test("S-016 Access Request 승인 후 trusted 항목 공개, private은 끝까지 비공개", async () => {
  const s = await signup();
  const p = await withProfile(s);
  const v = await signup();
  const req = await (await v.api.post(`/api/v1/profiles/${p.id}/access-requests`, { data: { fields: ["trusted"] } })).json();
  expect((await (await anon()).get(`/p/${p.slug}`)).ok()).toBe(true);
  await s.api.post(`/api/v1/access-requests/${req.id}`, { data: { approve: true } });
  const html = await (await v.api.get(`/p/${p.slug}`)).text();
  expect(html).toContain("010-1111-2222");
  expect(html).not.toContain("PRIVATE-NOTE-XYZ");
});

test("S-017 오래된 version으로 수정하면 409 version_conflict", async () => {
  const u = await signup();
  const p = await withProfile(u);
  expect((await u.api.patch(`/api/v1/profiles/${p.id}`, { data: { ...PROFILE, jobTitle: "CEO", version: 1 } })).status()).toBe(200);
  const r = await u.api.patch(`/api/v1/profiles/${p.id}`, { data: { ...PROFILE, jobTitle: "CTO", version: 1 } });
  expect(r.status()).toBe(409);
  expect((await r.json()).details.serverVersion).toBe(2);
});

test("S-018 남의 프로필 수정은 403", async () => {
  const a = await signup();
  const p = await withProfile(a);
  const b = await signup();
  expect((await b.api.patch(`/api/v1/profiles/${p.id}`, { data: PROFILE })).status()).toBe(403);
});

test("S-019 남의 전체 프로필(비공개 포함) 조회는 403", async () => {
  const a = await signup();
  const p = await withProfile(a);
  const b = await signup();
  expect((await b.api.get(`/api/v1/profiles/${p.id}`)).status()).toBe(403);
});

test("S-020 이름에 스크립트를 넣어도 공개 페이지에서 실행되지 않음(XSS)", async ({ page }) => {
  const u = await signup();
  const p = await withProfile(u, { name: '<img src=x onerror="window.__xss=1">' });
  await page.goto(`/p/${p.slug}`);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.getByRole("heading", { level: 2 }).first()).toContainText("<img");
});
