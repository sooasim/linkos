// F-012 사진첩 일괄 가져오기 — 200장 상한, 암호화 온디바이스 큐 적재, 새로고침 후 재개.
// 기기 OCR 엔진(tesseract.js)은 언어 데이터를 CDN 에서 받아야 해서 CI e2e 로는 돌리지 않는다(F-010 과 동일한 이유).
// 그래서 이 테스트는 오프라인 상태로 두어 인식 큐가 돌지 않게 한 다음, OCR 없이 결정적으로 확인할 수 있는
// 적재 단계만 검증한다. 인식 결과·검토 UI 는 tests/scenarios S-051~S-062 의 파서 테스트가 덮는다.
import { type Page, expect, test } from "@playwright/test";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

/** 1×1 PNG — 내용은 쓰이지 않는다(오프라인이라 인식이 시작되지 않음). 파일 하나당 70바이트. */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

async function signIn(page: Page, email: string) {
  await page.goto(`/login?next=${encodeURIComponent("/app/scan/import")}`);
  await page.getByLabel("이메일").fill(email);
  await page.getByRole("button", { name: "코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("6자리 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
  const consent = page.getByRole("button", { name: "전체 동의" });
  await Promise.race([consent.waitFor(), page.waitForURL(/\/app\/scan\/import/)]);
  if (await consent.isVisible()) {
    await consent.click();
    await page.getByRole("button", { name: "동의하고 가입 완료" }).click();
  }
  await page.waitForURL(/\/app\/scan\/import/);
}

test("F-012 batch import: caps the batch at 200, queues the photos encrypted on the device, resumes after a reload", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "one browser is enough for the on-device queue");
  await signIn(page, `batch${uniq()}@linkos.test`);
  await expect(page.getByText("가져올 사진이 없어요")).toBeVisible();
  // F-013 한 사진에 여러 명함 · 원본 보관은 적재 시점에 고르는 옵션이다
  await expect(page.getByLabel("한 사진에 여러 명함")).toBeVisible();
  await expect(page.getByLabel("원본 보관 (암호화)")).toBeVisible();

  // 오프라인이면 인식 큐가 돌지 않으므로(BatchImport 의 auto-resume 조건) 적재 결과만 남는다
  await context.setOffline(true);

  const files = Array.from({ length: 201 }, (_, i) => ({ name: `card-${i + 1}.png`, mimeType: "image/png", buffer: PNG_1X1 }));
  // 이미지가 아닌 파일은 걸러진다
  files.push({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await page.getByTestId("batch-input").setInputFiles(files);

  await expect(page.getByText("한 번에 최대 200장까지 가져올 수 있어요. 1장은 제외했어요.")).toBeVisible();
  const progress = page.getByRole("progressbar", { name: "일괄 가져오기 진행률" });
  await expect(progress).toHaveAttribute("aria-valuemax", "200");
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByText("0/200장 처리 · 검토 대기 0건")).toBeVisible();
  await expect(page.getByText("오프라인 · 대기 중")).toBeVisible();

  // 큐는 암호화되어 보관된다: IndexedDB 레코드에 파일명 평문이 없어야 한다
  const stored = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("linkos-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const recs: unknown[] = await new Promise((res, rej) => {
      const r = db.transaction("inbox").objectStore("inbox").getAll();
      r.onsuccess = () => res(r.result as unknown[]);
      r.onerror = () => rej(r.error);
    });
    return { count: recs.length, raw: JSON.stringify(recs) };
  });
  expect(stored.count).toBe(200);
  expect(stored.raw).not.toContain("card-1.png");

  // 재개: 새로고침해도 큐가 그대로 남아 있다(페이지가 열려 있을 때만 진행된다는 제약과 별개로 적재분은 보존)
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("progressbar", { name: "일괄 가져오기 진행률" })).toHaveAttribute("aria-valuemax", "200");
});
