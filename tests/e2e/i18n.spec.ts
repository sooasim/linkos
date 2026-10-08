// F-177 다국어: 게스트 수신 화면은 Accept-Language / ?lang / 쿠키에 따라 ko·en·ja 로 표시된다.
import { expect, test } from "@playwright/test";

test.describe("guest i18n (en browser)", () => {
  test.use({ locale: "en-US" });
  test("English browser sees English link state", async ({ page }) => {
    await page.goto("/x/not-a-real-token");
    await expect(page.getByRole("heading", { name: "Link not found" })).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("lang", "en");
  });
  test("?lang=ja overrides the browser language", async ({ page }) => {
    await page.goto("/x/not-a-real-token?lang=ja");
    await expect(page.getByRole("heading", { name: "リンクが見つかりません" })).toBeVisible();
  });
});

test("Korean browser keeps Korean", async ({ page }) => {
  await page.goto("/x/not-a-real-token");
  await expect(page.getByRole("heading", { name: "링크를 찾을 수 없어요" })).toBeVisible();
});
