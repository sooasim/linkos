// F-081 회의 녹음: 동의 기록 전에는 녹음 버튼 비활성 → 동의 후 MediaRecorder(가짜 마이크)로 녹음·파트 업로드·종료
import { type Page, expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }, permissions: ["microphone"] });

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function signIn(page: Page, email: string) {
  await page.goto(`/login?next=${encodeURIComponent("/app")}`);
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("6자리 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
  const consent = page.getByRole("button", { name: "전체 동의" });
  await Promise.race([consent.waitFor(), page.waitForURL(/\/app/)]);
  if (await consent.isVisible()) {
    await consent.click();
    await page.getByRole("button", { name: "동의하고 가입 완료" }).click();
  }
  await page.waitForURL(/\/app/);
}

test("recording starts only after consent, uploads encrypted parts and finalizes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "fake media devices are Chromium-only");
  await signIn(page, `rec${uniq()}@linkos.test`);
  const m = await (await page.request.post("/api/v1/meetings", { data: { title: "녹음 테스트" } })).json();
  await page.goto(`/app/meetings/${m.id}`);
  await expect(page.getByTestId("record-start")).toBeDisabled();
  await page.getByLabel("녹음·전사에 동의합니다").check();
  await page.getByLabel("모든 참여자에게 녹음 사실을 알리고 동의를 받았습니다").check();
  await page.getByRole("button", { name: "동의 기록" }).click();
  await expect(page.getByText("동의가 기록되었습니다.")).toBeVisible();
  await page.getByTestId("record-start").click();
  await expect(page.getByTestId("record-stop")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByTestId("record-stop").click();
  await expect(page.getByTestId("record-start")).toBeVisible({ timeout: 15_000 });
  const t = await (await page.request.get(`/api/v1/meetings/${m.id}/transcript`)).json();
  expect(t.recordings).toHaveLength(1);
  expect(t.recordings[0].parts).toBeGreaterThanOrEqual(1);
  expect(t.recordings[0].byteSize).toBeGreaterThan(0);
  // no STT provider in this environment → stored encrypted, honestly reported
  expect(t.recordings[0].status).toBe("stored");
  await expect(page.getByText(/저장됨\(전사 미설정\)/)).toBeVisible();
});
