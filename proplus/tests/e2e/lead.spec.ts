/**
 * P-100 공개 상담 요청 폼 · P-101 동의 분리 기록 · P-112 스팸 차단
 *
 * 모듈명세 M07 수용기준: "마케팅 동의는 상담 처리 동의와 분리된다."
 * 이 스펙은 N-11 이 UI 에서도 지켜지는지를 본다 — 체크박스 하나로 두 동의를 받으면 안 된다.
 */
import { expect, test } from "@playwright/test";

const SLUG = process.env.PROPLUS_E2E_SLUG ?? "demo-pro";

test.describe("상담 요청 (공개)", () => {
  test("인증 없이 폼이 열린다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);
    test.skip(res?.status() === 404, `시드 프로필 ${SLUG} 없음. pnpm proplus:db:seed 실행 필요.`);
    await page.getByRole("link", { name: /상담|문의/ }).first().click();
    await expect(page.getByTestId("lead-form")).toBeVisible();
  });

  test("P-101 / N-11: 상담 동의와 마케팅 동의가 별개 체크박스다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}/contact`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    const service = page.getByTestId("consent-service");
    const marketing = page.getByTestId("consent-marketing");

    await expect(service).toBeVisible();
    await expect(marketing).toBeVisible();

    // 둘이 같은 요소가 아니어야 한다 — "한 번에 동의" 패턴 금지 (보안정책 §3 목적 제한).
    const sameNode = await service.evaluate((a, b) => a === b, await marketing.elementHandle());
    expect(sameNode).toBe(false);

    // 마케팅은 기본 해제여야 한다. 기본 체크는 동의를 받은 것이 아니다.
    await expect(marketing).not.toBeChecked();
  });

  test("상담 동의 없이는 제출되지 않는다 (service 동의 필수)", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}/contact`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    await page.getByTestId("lead-name").fill("테스트 고객");
    await page.getByTestId("lead-contact").fill("test@example.com");
    // 동의를 체크하지 않고 제출
    await page.getByTestId("lead-submit").click();

    // 성공 화면으로 넘어가지 않아야 한다
    await expect(page.getByTestId("lead-success")).toHaveCount(0);
    await expect(page.getByTestId("lead-error")).toBeVisible();
  });

  test("마케팅 동의 없이 상담 동의만으로 제출된다", async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}/contact`);
    test.skip(res?.status() === 404, "시드 프로필 없음");

    await page.getByTestId("lead-name").fill("테스트 고객");
    // 중복 억제는 **마스킹된** 연락처(앞 2글자 + 도메인 전체)로 비교하므로, 도메인을 매번 다르게 해야
    // mobile·desktop 두 프로젝트가 같은 폼을 제출해도 서로 중복(409)으로 막히지 않는다.
    await page.getByTestId("lead-contact").fill(`e2e@d${Date.now()}.example.com`);
    await page.getByTestId("consent-service").check();
    await page.getByTestId("lead-submit").click();

    await expect(page.getByTestId("lead-success")).toBeVisible({ timeout: 10_000 });
  });

  test("P-102: 제출 응답에 연락처 원문이 돌아오지 않는다", async ({ request }) => {
    // 도메인을 유니크하게 — 마스킹 후에도 다른 제출과 구별돼 중복(409)으로 막히지 않는다.
    const email = `e2e@d${Date.now()}.example.com`;
    const res = await request.post(`/api/v1/public/profiles/${SLUG}/leads`, {
      data: {
        // 라우트 스키마(z.strictObject)는 contactKind·contact 를 받는다 — contactChannelKind/Channel 로
        // 보내면 unknown 키라 400 으로 거부된다 (UI 폼은 올바른 이름을 보내므로 통과한다).
        contactName: "테스트 고객",
        contactKind: "email",
        contact: email,
        message: "문의합니다",
        consents: [{ purpose: "service", granted: true, policyVersion: "privacy-2026-10-22" }],
      },
      headers: { origin: new URL(request.storageState ? "http://127.0.0.1:4400" : "http://127.0.0.1:4400").origin },
    });
    test.skip(res.status() === 404, "시드 프로필 없음");
    expect([200, 201]).toContain(res.status());
    const body = await res.text();
    // 응답에 평문 연락처를 되돌려주지 않는다 — 로그·중계 지점에 PII 가 퍼지는 경로를 막는다.
    expect(body).not.toContain(email);
  });

  test("P-112: 같은 폼을 연속 제출하면 rate limit 에 걸린다", async ({ request }) => {
    const origin = "http://127.0.0.1:4400";
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const res = await request.post(`/api/v1/public/profiles/${SLUG}/leads`, {
        data: {
          // contactKind/contact 가 맞는 키다. 또 도메인을 매번 다르게 해 **중복(409)이 아니라
          // rate limit(429)** 에 걸리는지 보게 한다 — 같은 마스킹이면 2번째부터 중복으로 막혀 rate
          // limit 에 닿지 못한다.
          contactName: "스팸",
          contactKind: "email",
          contact: `spam@d${i}-${Date.now()}.example.com`,
          consents: [{ purpose: "service", granted: true, policyVersion: "privacy-2026-10-22" }],
        },
        headers: { origin },
      });
      if (res.status() === 404) test.skip(true, "시드 프로필 없음");
      if (res.status() === 429) {
        limited = true;
        // 데이터모델 §5: 429 에는 retry-after 가 있어야 한다
        expect(res.headers()["retry-after"]).toBeTruthy();
        break;
      }
    }
    expect(limited, "8회 연속 제출이 전부 통과했다 — rate limit 이 동작하지 않는다 (P-112)").toBe(true);
  });
});
