// F-021 / F-022 Card design studio E2E: gallery → apply template (+accent, logo icon) → guest landing renders it;
// editor "템플릿" tab → save → public profile renders it; axe audit of the gallery page.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function signIn(page: Page, email: string, next = "/app") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("6자리 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
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
  await page.locator('input[name="company"]').fill("링코스 법률사무소");
  await page.locator('input[name="jobTitle"]').fill("변호사");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByLabel("값").first().fill(`lawyer${uniq()}@linkos.test`);
  await page.getByTestId("save-card").click();
  await page.waitForURL(/welcome=1/);
}

async function shortCodeFor(page: Page): Promise<string> {
  await page.goto("/app/exchange");
  await page.getByTestId("start-exchange").click();
  const code = await page
    .getByTestId("short-code")
    .textContent({ timeout: 10_000 })
    .catch(() => null);
  if (code?.trim()) return code.trim();
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId("qr-fallback").isVisible()) break;
    await page.getByTestId("next-channel").click();
    await page.waitForTimeout(600);
  }
  return (await page.evaluate(() => document.body.innerText.match(/\b[2-9A-HJKMNP-Z]{6}\b/)?.[0] ?? null))!;
}

test("F-021 apply a template from the gallery → guest landing renders it", async ({ page, browser }) => {
  await signIn(page, `tpl${uniq()}@linkos.test`);
  await createCard(page, "한서윤");

  await page.goto("/app/me");
  await page.getByTestId("open-templates").click();
  await page.waitForURL(/\/app\/me\/templates/);
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible({ timeout: 15_000 });
  // "추천 템플릿": a lawyer profile gets law-tagged templates first (deterministic suggestTemplates)
  await expect(page.getByTestId("template-suggestions").locator(":scope > li").first().getByRole("button")).toHaveAttribute("data-testid", /suggested-(crest-monogram|counsel-classic|academia)/);

  // filter by category + search, then pick a template
  await gallery.getByRole("button", { name: "럭셔리", exact: true }).click();
  await gallery.getByTestId("template-noir-gold-foil").click();
  await expect(page.getByTestId("template-current")).toContainText("누아르 골드 포일");
  await expect(page.locator('aside [data-template="noir-gold-foil"]')).toBeVisible();

  // accent override within the palette + logo icon from the icon bank (lazy picker)
  await page.getByTestId("accent-1").click();
  await page.getByTestId("logo-icon").click();
  const picker = page.getByTestId("icon-picker");
  await expect(picker).toBeVisible();
  await picker.getByLabel("아이콘 검색").fill("보석");
  await picker.locator('[data-ref="i:gem"]').click();
  await expect(picker).toHaveCount(0);

  await page.getByTestId("apply-template").click();
  await page.waitForURL(/\/app\/me$/);
  await expect(page.locator('[data-template="noir-gold-foil"]').first()).toBeVisible();

  // Guest (no session) sees the template on the exchange landing, without any login wall
  const code = await shortCodeFor(page);
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/c/${code}`);
  const face = guest.locator('[data-template="noir-gold-foil"] [data-testid="card-face"]');
  await expect(face).toBeVisible({ timeout: 15_000 });
  await expect(face.getByTestId("tc-name")).toHaveText("한서윤");
  await expect(face.locator("svg path").first()).toBeVisible();
  await expect(guest.getByText("로그인", { exact: true })).toHaveCount(0);
  await guestCtx.close();
});

test("F-021 editor 템플릿 tab → save → public profile renders the template; icon picker keyboard + emoji", async ({ page }) => {
  await signIn(page, `tpl2${uniq()}@linkos.test`);
  await createCard(page, "Mina Seo");

  await page.goto("/app/me/edit");
  await page.getByTestId("edit-tab-template").click();
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible({ timeout: 15_000 });
  await gallery.getByLabel("템플릿 검색").fill("blueprint");
  await gallery.getByTestId("template-blueprint").click();
  await expect(page.locator('aside [data-template="blueprint"]')).toBeVisible();

  // field icon via keyboard in the emoji tab
  await page.getByTestId("edit-tab-info").click();
  await page.getByRole("button", { name: /이메일 아이콘 선택/ }).click();
  const picker = page.getByTestId("icon-picker");
  await picker.getByRole("tab", { name: "이모지" }).click();
  await picker.getByLabel("이모지 검색").fill("이메일");
  await picker.getByLabel("이모지 검색").press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: /이메일 아이콘: .* \(변경\)/ })).toBeVisible();

  await page.getByTestId("save-card").click();
  await page.waitForURL(/\/app\/me$/);
  const href = await page.getByRole("link", { name: /공개 프로필 페이지/ }).getAttribute("href");
  await page.goto(href!);
  await expect(page.locator('[data-template="blueprint"] [data-testid="card-face"]')).toBeVisible();
});

test.describe("F-021 a11y", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });
  test("axe: template gallery page has no WCAG A/AA violations", async ({ page }) => {
    await signIn(page, `tpl3${uniq()}@linkos.test`);
    await createCard(page, "홍길동");
    await page.goto("/app/me/templates");
    await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("template-suggestions").locator(":scope > li")).toHaveCount(6);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    // the open icon picker dialog is accessible too
    await page.getByTestId("logo-icon").click();
    await expect(page.getByTestId("glyph-grid")).toBeVisible();
    const r2 = await new AxeBuilder({ page }).include('[data-testid="icon-picker"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(r2.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});
