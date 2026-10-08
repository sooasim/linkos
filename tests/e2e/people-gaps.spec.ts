// UX-001/UX-011/UX-012 gaps: F-063 첫 공유 유도, F-098 Home AI 추천, F-065 직접 추가, F-070 태그, F-078/F-109 후속 할 일,
// F-067 만남 기록, F-019/F-066 명함 원본 패널, nav: 설정 진입 + 알림함 배지 라벨
import { type Page, expect, test } from "@playwright/test";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
// 1×1 PNG — re-encoded server-side like any card photo
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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
  await page.locator('input[name="company"]').fill("링코스랩");
  await page.locator('input[name="jobTitle"]').fill("대표");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByLabel("값").first().fill(`ceo${uniq()}@linkos.test`);
  await page.getByTestId("save-card").click();
  await page.waitForURL(/welcome=1/);
}

test("F-063 welcome card → first share, F-098 AI 추천 block, settings + inbox entry points", async ({ page }) => {
  await signIn(page, `home${uniq()}@linkos.test`);
  await createCard(page, "이도윤");

  const welcome = page.getByTestId("welcome-card");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("다음 만나는 사람에게");
  await expect(page.getByTestId("welcome-share")).toHaveAttribute("href", "/app/exchange");

  const ai = page.getByTestId("home-ai");
  await expect(ai).toBeVisible();
  await expect(ai.getByText("AI 추론")).toBeVisible();
  await expect(ai).toContainText("지금은 챙길 사람이 없어요"); // empty state for a new account

  await page.getByRole("link", { name: "첫 공유 안내 닫기" }).click();
  await page.waitForURL((u) => u.pathname === "/app" && !u.search.includes("welcome"));
  await expect(page.getByTestId("welcome-card")).toHaveCount(0);

  if (test.info().project.name === "mobile-safari-size") {
    // Home "모든 기능" grid + top utility bar both reach settings on mobile
    await expect(page.locator('main a[href="/app/settings"]')).toBeVisible();
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-label", /^알림함/);
    await page.getByTestId("nav-settings").click();
  } else {
    await page.getByRole("navigation", { name: "사이드 메뉴" }).getByRole("link", { name: "설정·연동" }).click();
  }
  await page.waitForURL(/\/app\/settings/);
});

test("person page: manual add, tags, follow-up, encounter, original card images; people list sort/tags/error", async ({ page }) => {
  await signIn(page, `people${uniq()}@linkos.test`, "/app/people");

  // UX-011 직접 추가 (F-065)
  await page.getByTestId("manual-add").click();
  const form = page.getByTestId("manual-contact");
  await form.locator('input[name="fullName"]').fill("박서준");
  await form.locator('input[name="company"]').fill("가나다상사");
  await form.getByRole("button", { name: "저장" }).click();
  await page.waitForURL(/\/app\/people\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "박서준" })).toBeVisible();

  // F-070 tags: add two, remove one
  const tagInput = page.getByLabel("태그 추가");
  await tagInput.fill("VIP");
  await tagInput.press("Enter");
  await expect(page.getByTestId("contact-tags")).toContainText("#VIP");
  await tagInput.fill("의료");
  await page.getByRole("button", { name: "태그 저장" }).click();
  await expect(page.getByTestId("contact-tags")).toContainText("#의료");
  await page.getByRole("button", { name: "VIP 태그 삭제" }).click();
  await expect(page.getByTestId("contact-tags")).not.toContainText("#VIP");
  await expect(page.getByTestId("contact-tags")).toContainText("#의료");

  // F-078/F-109 follow-up (section visible even when empty)
  const followups = page.getByTestId("followups");
  await expect(followups).toContainText("열린 후속 할 일이 없어요");
  await followups.getByLabel("후속 할 일 제목").fill("제안서 보내기");
  const due = new Date(Date.now() + 3 * 864e5);
  await followups.getByLabel("기한 (선택)").fill(`${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`);
  await followups.getByLabel("종류").selectOption("send_material");
  await followups.getByRole("button", { name: "후속 할 일 추가" }).click();
  await expect(followups.locator("li", { hasText: "제안서 보내기" })).toContainText("자료 전달 · 기한");

  // F-067 encounter on the timeline
  await page.getByRole("button", { name: "만남 기록" }).click();
  await page.getByLabel("만난 장소").fill("코엑스 라운지");
  await page.getByLabel("만남 메모").fill("투자 이야기");
  await page.getByRole("button", { name: "기록하기" }).click();
  await expect(page.locator("ol li", { hasText: "코엑스 라운지 · 투자 이야기" })).toBeVisible();

  // F-019/F-066 원본 패널: hidden without images
  await expect(page.getByTestId("card-images")).toHaveCount(0);
  const cap = await page.request.post("/api/v1/capture/cards", { data: { lines: [{ text: "최하늘", confidence: 95 }, { text: "하늘테크 이사", confidence: 90 }] } });
  expect(cap.ok()).toBeTruthy();
  const cardId = (await cap.json()).id as string;
  const made = await page.request.post("/api/v1/contacts", { data: { fullName: "최하늘", company: "하늘테크", source: "scan", businessCardId: cardId, tags: ["파트너"] } });
  expect(made.ok()).toBeTruthy();
  const otherId = (await made.json()).contactId as string;
  const put = await page.request.put(`/api/v1/capture/cards/${cardId}/images/front`, { data: PNG, headers: { "content-type": "image/png" } });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/app/people/${otherId}`);
  const panel = page.getByTestId("card-images");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("img", { name: "명함 앞면" })).toHaveAttribute("loading", "lazy");
  await panel.getByRole("button", { name: "명함 앞면 크게 보기" }).click();
  const dialog = page.getByRole("dialog", { name: "명함 원본 크게 보기" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  page.once("dialog", (d) => d.accept());
  await panel.getByRole("button", { name: "명함 앞면 원본 삭제" }).click();
  await expect(page.getByTestId("card-images")).toHaveCount(0);

  // UX-011 list: tag chips come from the whole book, sort, error + retry
  await page.goto("/app/people");
  await expect(page.getByTestId("people-list")).toContainText("박서준");
  await page.getByRole("button", { name: "#의료" }).click();
  await expect(page.getByTestId("people-list")).not.toContainText("최하늘");
  await expect(page.getByRole("button", { name: "#파트너" })).toBeVisible(); // other tags stay selectable
  await page.getByRole("button", { name: "전체" }).click();
  await page.getByTestId("people-sort").selectOption("name");
  await expect(page.getByTestId("people-list").locator("li").first()).toContainText("박서준"); // 박 < 최
  await page.getByTestId("people-sort").selectOption("company");
  await expect(page.getByRole("heading", { name: /가나다상사 · 1/ })).toBeVisible();

  await page.route("**/api/v1/contacts?*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "일시적인 오류" }) }));
  await page.getByLabel("인맥 검색").fill("박");
  await expect(page.getByTestId("people-error")).toBeVisible();
  await page.unroute("**/api/v1/contacts?*");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("people-list")).toContainText("박서준");
});

// design system §5 접근성: the new blocks pass axe WCAG A/AA in light + dark
for (const scheme of ["light", "dark"] as const) {
  test(`axe (${scheme}): welcome card, AI 추천, people tools, person-page forms`, async ({ page }) => {
    const AxeBuilder = (await import("@axe-core/playwright")).default;
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await signIn(page, `axe${scheme}${uniq()}@linkos.test`);
    const audit = async (...selectors: string[]) => {
      let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
      for (const s of selectors) b = b.include(s);
      const r = await b.analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    };
    await page.goto("/app?welcome=1");
    await expect(page.getByTestId("welcome-card")).toBeVisible();
    await audit("[data-testid=welcome-card]", "[data-testid=home-ai]");
    await page.goto("/app/people");
    await page.getByTestId("manual-add").click();
    await audit("[data-testid=manual-contact]", "[data-testid=people-sort]");
    await page.getByTestId("manual-contact").locator('input[name="fullName"]').fill("한지민");
    await page.getByTestId("manual-contact").getByRole("button", { name: "저장" }).click();
    await page.waitForURL(/\/app\/people\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: "만남 기록" }).click();
    await audit("[data-testid=contact-tags]", "[data-testid=followups]", "form[aria-label='만남 기록']");
  });
}
