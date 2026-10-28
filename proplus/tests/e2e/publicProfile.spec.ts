/**
 * P-025 공개 프로필 페이지 · P-026 공개 DTO allowlist · P-058 배지 6필드 · P-069 배지 설명 패널
 *
 * 모듈명세 M02 수용기준: "모바일에서 핵심 소개·검증 상태·상담 CTA 가 첫 화면에 표시되고,
 * 공개 필드 외 정보는 반환되지 않는다."
 *
 * 이 스펙은 시드 데이터에 의존한다 — proplus/db/seeds/seed.ts 가 만드는 `demo-pro` 프로필.
 * 시드가 없으면 전체를 skip 한다(CI 에서 조용히 통과하지 않도록 이유를 출력한다).
 */
import { expect, test } from "@playwright/test";

const SLUG = process.env.PROPLUS_E2E_SLUG ?? "demo-pro";

test.describe("공개 프로필 /p/{slug}", () => {
  test("인증 없이 열린다 — 로그인 화면으로 보내지 않는다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, `시드 프로필 ${SLUG} 가 없다. pnpm proplus:db:seed 를 먼저 실행하라.`);
    expect(res?.status()).toBe(200);
    // 기획서 §5-7 접근성: "앱 설치 없이 모바일 웹 프로필을 열 수 있게 한다"
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("첫 화면에 전문분야·검증 상태·상담 CTA 가 보인다 (M02 수용기준)", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    // 뷰포트 안(스크롤 없이)에 있어야 한다. 브랜드 §6: "첫 화면 5초 안에".
    const cta = page.getByRole("link", { name: /상담|문의/ }).first();
    await expect(cta).toBeInViewport();

    const headline = page.getByTestId("profile-headline");
    await expect(headline).toBeVisible();

    // 검증 상태 영역. 배지가 없는 프로필도 "검증 항목 없음"을 보여줘야 한다
    // — 상태를 숨기지 않는 것이 브랜드 §3 원칙이다.
    await expect(page.getByTestId("trust-section")).toBeVisible();
  });

  test("P-058: 배지는 강도·범위·검증일을 함께 보여준다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    const badges = page.getByTestId("badge");
    const n = await badges.count();
    test.skip(n === 0, "시드에 배지가 없다");

    const first = badges.first();
    // 색만으로 상태를 구분하지 않는다 (브랜드 §7) — 텍스트가 반드시 있다.
    await expect(first.getByTestId("badge-method")).toBeVisible();
    await expect(first.getByTestId("badge-scope")).toBeVisible();
    await expect(first.getByTestId("badge-verified-at")).toBeVisible();
  });

  test("P-069: 배지를 열면 설명·출처 유형·검증일이 나온다 (브랜드 §6)", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    const disclosure = page.getByTestId("badge-disclosure").first();
    test.skip((await disclosure.count()) === 0, "시드에 배지가 없다");

    // <details>/<summary> 기반이므로 JS 없이도 열린다 (점진적 향상).
    // summary 를 클릭한다 — details 본체를 클릭하면 열린 뒤에는 패널 영역을 눌러 다시 닫힌다.
    await disclosure.getByTestId("badge-disclosure-summary").click();
    await expect(disclosure.getByTestId("badge-disclosure-body")).toBeVisible();
  });

  test("P-026 / N-4: 공개 API 응답에 비공개 필드가 없다", async ({ request }) => {
    const res = await request.get(`/api/v1/public/profiles/${SLUG}`);
    test.skip(res.status() === 404, "시드 프로필 없음");
    expect(res.status()).toBe(200);
    const body = await res.text();

    // 데이터모델 §3 비공개 예시가 응답 본문에 **문자열로도** 나타나지 않아야 한다.
    for (const key of [
      "contactChannelEncrypted",
      "reviewerNote",
      "objectKey",
      "encryptionRef",
      "internalNote",
      "trustScore",
      "retentionUntil",
      "userId",
    ]) {
      expect(body, `공개 응답에 ${key} 가 들어 있다 (N-4 위반)`).not.toContain(key);
    }
  });

  test("P-027: 비발행 프로필은 404 다", async ({ page }) => {
    const res = await page.goto("/p/__definitely-not-published__");
    expect(res?.status()).toBe(404);
  });

  test("P-030: SEO 메타데이터가 있다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, "시드 프로필 없음");
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
  });

  test("P-035: vCard 를 내려받을 수 있고 비공개 연락처가 들어가지 않는다", async ({ request }) => {
    const res = await request.get(`/api/v1/public/profiles/${SLUG}/vcard`);
    test.skip(res.status() === 404, "시드 프로필 없음");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/vcard");
    const card = await res.text();
    expect(card).toContain("BEGIN:VCARD");
    // 공개 동의가 없으면 TEL/EMAIL 줄이 아예 없어야 한다 (기술백서 §6).
    // 시드가 공개로 설정했다면 이 단정은 건너뛴다.
    if (!card.includes("X-PROPLUS-CONTACT-PUBLIC:1")) {
      expect(card).not.toMatch(/^TEL/m);
      expect(card).not.toMatch(/^EMAIL/m);
    }
  });

  test("P-193: 접근성 — 아이콘 버튼에 접근 가능한 이름이 있다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, "시드 프로필 없음");
    const buttons = page.locator("button, a[role=button]");
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const name = (await b.getAttribute("aria-label")) ?? (await b.innerText()).trim();
      expect(name, `이름 없는 버튼 #${i}`).not.toBe("");
    }
  });
});
