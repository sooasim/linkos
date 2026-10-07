// J. 기기 · 화면 · 접근성 (S-095 ~ S-100)
import { devices, expect, test } from "@playwright/test";
import { session, signup, withProfile } from "./helpers";

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test("S-095 iPhone SE(375px): 랜딩 가로 스크롤 없음, CTA 노출", async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices["iPhone SE"], browserName: undefined } as never);
  const page = await ctx.newPage();
  await page.goto("/");
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByRole("link", { name: /무료로 시작하기/ })).toBeVisible();
  await ctx.close();
});

test("S-096 Galaxy(Android) 크기에서 게스트 랜딩 → 직접입력 회신 완료", async ({ browser }) => {
  const s = await signup();
  await withProfile(s);
  const x = await session(s);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36" });
  const page = await ctx.newPage();
  await page.goto(`/x/${x.token}`);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("reply-cta").tap();
  await page.getByRole("button", { name: "직접 입력할게요" }).tap();
  await page.locator('input[name="fullName"]').fill("안드로이드");
  await page.locator('input[name="consent"]').check();
  await page.getByTestId("send-cta").tap();
  await expect(page.getByRole("heading", { name: /교환 완료/ })).toBeVisible();
  await ctx.close();
});

test("S-097 iPad 가로: 로그인 화면 2단 레이아웃", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByRole("complementary")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await ctx.close();
});

test("S-098 다크 모드 선호 시 앱 배경이 잉크색", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/legal/terms");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(14, 14, 16)");
  await ctx.close();
});

test("S-099 모션 감소 설정 시 애니메이션 사실상 비활성", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  const d = await page.evaluate(() => getComputedStyle(document.querySelector(".animate-marquee")!).animationDuration);
  expect(parseFloat(d)).toBeLessThan(0.01);
  await ctx.close();
});

test("S-100 키보드만으로 로그인 폼 이동 가능, 포커스 표시", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("이메일").focus();
  await page.keyboard.type("kb@scn.test");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
  expect(focused).toContain("코드 받기");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
});
