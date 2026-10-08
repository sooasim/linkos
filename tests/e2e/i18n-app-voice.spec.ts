// F-177 다국어 (signed-in app shell ko/en) · F-112 카드 번역 검토 UI · F-080 음성 메모 구조화(자동 추출 → 확인 후 후속 할 일)
import { type Page, expect, test } from "@playwright/test";
import { applyCardTranslation, availableTranslations, draftFromApi } from "../../apps/web/src/lib/cardTranslation";
import { extractTodos, formatElapsed, splitSentences } from "../../apps/web/src/lib/voiceMemo";

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
  await page.locator('input[name="company"]').fill("링코스랩");
  await page.locator('input[name="jobTitle"]').fill("대표");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByLabel("값").first().fill(`ceo${uniq()}@linkos.test`);
  await page.getByTestId("save-card").click();
  await page.waitForURL(/welcome=1/);
}

// ---------- pure logic (no browser) ----------
test.describe("F-080 voice memo extractor (unit)", () => {
  const now = new Date(2026, 9, 8, 14, 0); // Thu 2026-10-08 14:00 local

  test("pulls to-dos and dates from a Korean memo, skips past-tense small talk", () => {
    const memo = "오늘 코엑스에서 만났다. 다음 주 화요일까지 제안서 보내기로 했어요. 김 대표에게 견적 전달하기 그리고 10월 20일에 미팅 잡기. 날씨가 좋았다.";
    const todos = extractTodos(memo, now);
    expect(todos.map((t) => t.title)).toEqual(["다음 주 화요일까지 제안서 보내기로 했어요", "김 대표에게 견적 전달하기", "10월 20일에 미팅 잡기"]);
    expect(todos[0]!.kind).toBe("send_material");
    expect(new Date(todos[0]!.dueAt!).getDate()).toBe(13); // Tue of next week
    expect(todos[0]!.dueText).toBe("다음 주 화요일");
    expect(todos[1]!.dueAt).toBeNull(); // no date named → none invented
    expect(todos[2]!.kind).toBe("meeting_request");
    const d = new Date(todos[2]!.dueAt!);
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([10, 20, 9]);
  });

  test("English cues and relative dates; deterministic for the same input", () => {
    const memo = "Send the deck by Friday. Lunch was great. Schedule a call next week. Reply in 3 days";
    const a = extractTodos(memo, now);
    expect(a.map((t) => t.title)).toEqual(["Send the deck by Friday", "Schedule a call next week", "Reply in 3 days"]);
    expect(new Date(a[0]!.dueAt!).getDate()).toBe(9);
    expect(new Date(a[1]!.dueAt!).getDate()).toBe(12); // Monday of next week
    expect(new Date(a[2]!.dueAt!).getDate()).toBe(11);
    expect(extractTodos(memo, now)).toEqual(a);
  });

  test("helpers", () => {
    expect(splitSentences("- 자료 보내기\n2) 내일 연락하기")).toEqual(["자료 보내기", "내일 연락하기"]);
    expect(extractTodos("", now)).toEqual([]);
    expect(formatElapsed(65_400)).toBe("01:05");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});

test.describe("F-112 card translation helpers (unit)", () => {
  test("translation never touches name/company/contact fields and ignores stale sources", () => {
    const card = { name: "홍길동", company: "링코스랩", jobTitle: "대표", headline: "의료 AI", bioShort: null, offers: ["의료 영상 AI"], needs: ["유통 파트너"], fields: [{ type: "email", value: "a@b.test" }] };
    const draft = draftFromApi({ jobTitle: "대표", headline: "의료 AI", bioShort: null, offers: ["의료 영상 AI"], needs: ["유통 파트너"] }, { jobTitle: "CEO", headline: "Medical AI", "offer.0": "Medical imaging AI" });
    const t = { ...draft, provenance: "ai_inferred" as const, reviewedAt: "2026-10-08T00:00:00Z" };
    const { card: out, applied } = applyCardTranslation(card, t);
    expect(applied).toBe(true);
    expect(out).toMatchObject({ name: "홍길동", company: "링코스랩", jobTitle: "CEO", headline: "Medical AI", offers: ["Medical imaging AI"], needs: ["유통 파트너"] });
    expect(out.fields).toEqual(card.fields);
    // the owner edited the original after translating → the stale translation is not shown
    expect(applyCardTranslation({ ...card, jobTitle: "공동대표" }, t).card.jobTitle).toBe("공동대표");
    expect(availableTranslations({ en: t })).toEqual(["en"]);
    expect(availableTranslations(null)).toEqual([]);
  });
});

// ---------- browser flows ----------
test("F-177 language switch: Settings → English changes the app shell and <html lang>, Korean stays default", async ({ page }) => {
  await signIn(page, `i18n${uniq()}@linkos.test`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("heading", { name: "후속 필요" })).toBeVisible();

  await page.goto("/app/settings");
  await expect(page.getByTestId("language-settings")).toBeVisible();
  await page.getByTestId("lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("lang-en")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { name: /Integrations · Export · Privacy/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();

  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Needs follow-up" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);
  const nav = page.getByRole("navigation", { name: /Main menu|Side menu/ }).first();
  await expect(nav.getByRole("link", { name: /People/ })).toBeVisible();

  await page.goto("/app/people");
  await expect(page.getByRole("heading", { name: "My people" })).toBeVisible();
  await expect(page.getByPlaceholder("Search name, company, title, email")).toBeVisible();

  await page.goto("/app/exchange");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/card to exchange|in one tap/);

  // back to Korean
  await page.goto("/app/settings");
  await page.getByTestId("lang-ko").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "후속 필요" })).toBeVisible();
});

test("F-177 login page language switch", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByLabel("이메일")).toBeVisible();
  await page.getByTestId("login-lang-switch").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get code" })).toBeVisible();
  await ctx.close();
});

test("F-112 card translation: review before adding, names never translated", async ({ page }) => {
  await signIn(page, `tr${uniq()}@linkos.test`);
  await createCard(page, "번역테스트");
  await page.goto("/app/me/edit");
  const section = page.getByTestId("card-translations");
  await expect(section).toBeVisible();
  await section.getByTestId("translate-en").click();
  const review = page.getByTestId("translation-review");
  await expect(review).toBeVisible({ timeout: 20_000 });
  // AI-translated (labelled) or, without an engine, the original with a notice — never silently applied
  await expect(review.getByText(/AI 번역 · 확인 필요|번역 불가 · 원문/)).toBeVisible();
  await expect(review.getByTestId("locked-name")).toHaveText("번역테스트");
  const jobTitle = review.getByLabel("직책 번역");
  await expect(jobTitle).toBeVisible();
  await jobTitle.fill("CEO");
  await review.getByTestId("translation-apply").click();
  await expect(page.getByTestId("translation-review")).toHaveCount(0);
  await expect(section.getByTestId("translation-en")).toBeVisible();

  await page.getByTestId("save-card").click();
  const notice = page.getByTestId("save-notice");
  const stored = await Promise.race([
    notice.waitFor({ timeout: 15_000 }).then(() => false),
    page.waitForURL(/\/app\/me$/, { timeout: 15_000 }).then(() => true),
  ]);
  if (!stored) {
    // the server does not store translations yet: the UI says so instead of dropping them silently
    await expect(notice).toContainText("번역본은 저장되지 않았어요");
    return;
  }
  const me = await (await page.request.get("/api/v1/me")).json();
  await page.goto(`/p/${me.profile.slug}?lang=en`);
  await expect(page.getByTestId("card-lang-picker")).toBeVisible();
  await expect(page.getByText("CEO").first()).toBeVisible();
  await expect(page.getByText("번역테스트").first()).toBeVisible();
});

test("F-080 voice memo: dictation timer, 정리하기 → suggestions → confirm one → follow-up appears", async ({ page }) => {
  // simulated speech recognition (the real one needs a microphone)
  await page.addInitScript(() => {
    class FakeRec {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        setTimeout(() => this.onresult?.({ results: [[{ transcript: "다음 주 화요일까지 제안서 보내기로 했어요." }]] }), 300);
      }
      stop() {
        setTimeout(() => this.onend?.(), 50);
      }
    }
    const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
    w.webkitSpeechRecognition = FakeRec;
    w.SpeechRecognition = FakeRec;
  });
  await signIn(page, `voice${uniq()}@linkos.test`);
  const created = await (await page.request.post("/api/v1/contacts", { data: { fullName: "음성메모 테스트", company: "메디파트너스" } })).json();
  const id = created.contactId as string;
  await page.goto(`/app/people/${id}#note`);
  await expect(page.getByRole("heading", { name: "음성메모 테스트" })).toBeVisible();

  await page.getByRole("button", { name: "음성 메모" }).click();
  await expect(page.getByTestId("dictation-timer")).toContainText(/받아쓰는 중 00:0\d/);
  await expect(page.getByPlaceholder("무슨 이야기를 나눴나요?")).toHaveValue(/제안서 보내기로/);
  await page.getByRole("button", { name: "받아쓰기 중지" }).click();
  await expect(page.getByTestId("dictation-timer")).toHaveCount(0);

  // add a typed sentence too
  const box = page.getByPlaceholder("무슨 이야기를 나눴나요?");
  await box.fill(`${await box.inputValue()} 김 대표에게 견적 전달하기. 오늘 코엑스에서 만났다.`);
  const before = (await (await page.request.get("/api/v1/followups")).json()).followups.length;

  await page.getByTestId("memo-structure").click();
  const panel = page.getByTestId("memo-suggestions");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("자동 추출")).toBeVisible();
  await expect(panel.getByTestId("memo-suggestion")).toHaveCount(2);
  // nothing is created until confirmed
  expect((await (await page.request.get("/api/v1/followups")).json()).followups.length).toBe(before);

  const first = panel.getByTestId("memo-suggestion").first();
  await expect(first.getByLabel("할 일")).toHaveValue("다음 주 화요일까지 제안서 보내기로 했어요");
  await first.getByTestId("memo-confirm").click();
  await expect(first).toContainText("추가됨");
  await panel.getByTestId("memo-suggestion").nth(1).getByRole("button", { name: "무시" }).click();
  await expect(panel.getByTestId("memo-suggestion")).toHaveCount(1);

  await expect(page.getByRole("heading", { name: "후속 할 일" })).toBeVisible();
  await expect(page.locator("li", { hasText: "다음 주 화요일까지 제안서 보내기로 했어요" }).getByRole("button", { name: "완료" })).toBeVisible();
  const after = (await (await page.request.get("/api/v1/followups")).json()).followups;
  expect(after.length).toBe(before + 1);
  expect(after.find((f: { title: string }) => f.title.includes("제안서"))?.due_at).toBeTruthy();

  // the memo itself is saved as a private voice note
  await page.getByRole("button", { name: "메모 추가" }).click();
  await expect(page.getByText("개인 메모").first()).toBeVisible();
});

test("people list: company filter", async ({ page }) => {
  await signIn(page, `co${uniq()}@linkos.test`);
  await page.request.post("/api/v1/contacts", { data: { fullName: "회사A 사람", company: "알파상사" } });
  await page.request.post("/api/v1/contacts", { data: { fullName: "회사B 사람", company: "베타물산" } });
  await page.goto("/app/people");
  await expect(page.getByText("회사A 사람")).toBeVisible();
  await page.getByTestId("company-filter").selectOption("베타물산");
  await expect(page.getByText("회사B 사람")).toBeVisible();
  await expect(page.getByText("회사A 사람")).toHaveCount(0);
});
