// P0 E2E: Exchange before signup → claim after (F-002, F-003, F-037, F-041, F-045, F-048, F-053~F-061)
import { type Page, expect, test } from "@playwright/test";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function signIn(page: Page, email: string, next = "/app") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("6자리 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
  // first-time users get the separated consent step
  const consent = page.getByRole("button", { name: "전체 동의" });
  const target = new RegExp(next.replace(/[/?]/g, "\\$&"));
  await Promise.race([consent.waitFor(), page.waitForURL(target)]);
  if (await consent.isVisible()) {
    await consent.click();
    await page.getByRole("button", { name: "동의하고 가입 완료" }).click();
  }
  await page.waitForURL(target);
}

async function createCard(page: Page, name: string) {
  await page.goto("/app/me/edit?onboarding=1");
  const manual = page.getByRole("button", { name: "직접 입력할게요" });
  if (await manual.isVisible().catch(() => false)) await manual.click();
  await page.locator('input[name="name"]').fill(name);
  await page.locator('input[name="company"]').fill("링코스랩");
  await page.locator('input[name="jobTitle"]').fill("대표");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByLabel("값").first().fill(`ceo${uniq()}@linkos.test`);
  await page.getByTestId("save-card").click();
  await page.waitForURL(/welcome=1/);
}

test("guest receives a card without login, replies, then claims", async ({ page, browser }) => {
  await signIn(page, `sender${uniq()}@linkos.test`);
  await createCard(page, "홍길동");

  await page.goto("/app/exchange");
  await page.getByTestId("start-exchange").click();
  // QR is not shown first (F-048)
  await expect(page.getByTestId("qr-fallback")).toHaveCount(0);
  const code = (await page.getByTestId("short-code").textContent({ timeout: 10_000 }).catch(() => null)) ?? null;

  // advance the ladder manually until QR appears automatically as the final fallback
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId("qr-fallback").isVisible()) break;
    await page.getByTestId("next-channel").click();
    await page.waitForTimeout(600);
  }
  await expect(page.getByTestId("qr-fallback")).toBeVisible();
  const shortCode = code ?? (await page.evaluate(() => document.querySelector("[data-testid=short-code]")?.textContent?.match(/\d{4}/)?.[0] ?? null));

  // Guest: separate browser context, no session
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/c/${shortCode}`);
  await expect(guest.getByRole("heading", { name: /홍길동님의/ })).toBeVisible();
  await expect(guest.getByText("로그인", { exact: true })).toHaveCount(0); // no login wall
  await guest.getByTestId("reply-cta").click();
  await guest.getByRole("button", { name: "직접 입력할게요" }).click();
  await guest.locator('input[name="fullName"]').fill("김영희");
  await guest.locator('input[name="company"]').fill("메디파트너스");
  await guest.locator('input[name="email"]').fill(`yh${uniq()}@medi.test`);
  await expect(guest.getByTestId("send-cta")).toBeDisabled(); // consent required
  await guest.locator('input[name="consent"]').check();
  await guest.getByTestId("send-cta").click();
  await expect(guest.getByRole("heading", { name: /교환 완료/ })).toBeVisible();

  // Sender sees it live (SSE)
  await expect(page.getByTestId("exchange-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("exchange-done")).toContainText("김영희");

  // Claim AFTER exchange
  await guest.getByTestId("claim-cta").click();
  await guest.getByTestId("claim-login").click();
  await signIn(guest, `claimer${uniq()}@medi.test`, "/claim");
  await guest.waitForURL(/\/claim/);
  await guest.getByTestId("claim-confirm").click();
  await guest.waitForURL(/\/app\/me\/edit/);
  await guest.goto("/app/people");
  await expect(guest.getByText("홍길동")).toBeVisible();
  await guestCtx.close();
});

test("expired or unknown links show a friendly state", async ({ page }) => {
  await page.goto("/x/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "링크를 찾을 수 없어요" })).toBeVisible();
});

test("app routes require login; landing is public", async ({ page }) => {
  await page.goto("/app/people");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Remember");
});
