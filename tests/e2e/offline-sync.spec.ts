// F-150 오프라인 모드 / F-178 오프라인 캡처(암호화 로컬 큐) / F-052 오프라인 큐 / F-179 재동기화(멱등 재전송 + 충돌 해결)
import { type Page, expect, test } from "@playwright/test";

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

test("offline edits and notes are queued encrypted, replayed once on reconnect, and conflicts are resolved by the user", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "one browser is enough for the offline queue");
  await signIn(page, `offline${uniq()}@linkos.test`);
  const created = await (await page.request.post("/api/v1/contacts", { data: { fullName: "오프라인 테스트", jobTitle: "매니저" } })).json();
  const id = created.contactId as string;
  await page.goto(`/app/people/${id}`);
  await expect(page.getByRole("heading", { name: "오프라인 테스트" })).toBeVisible();

  await context.setOffline(true);
  await page.getByRole("button", { name: "정보 편집" }).click();
  await page.getByLabel("직책").fill("이사(오프라인 수정)");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText(/오프라인 상태라 이 기기에 암호화해 보관했어요/)).toBeVisible();
  await page.getByRole("button", { name: "정보 편집" }).click();
  await page.getByPlaceholder("무슨 이야기를 나눴나요?").fill("전시회 부스에서 만남");
  await page.getByRole("button", { name: "메모 추가" }).click();
  await expect(page.getByTestId("offline-indicator")).toContainText("오프라인");
  await expect(page.getByTestId("offline-indicator")).toContainText("전송 대기 2건");

  // the queue is encrypted at rest: no plaintext of the note in IndexedDB
  const plaintextLeak = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("linkos-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all: any[] = await new Promise((res) => {
      const r = db.transaction("outbox").objectStore("outbox").getAll();
      r.onsuccess = () => res(r.result);
    });
    const dec = new TextDecoder();
    return { count: all.length, leak: all.some((x) => dec.decode(x.enc.data).includes("부스") || JSON.stringify(x).includes("부스")) };
  });
  expect(plaintextLeak).toEqual({ count: 2, leak: false });

  // meanwhile the contact changes elsewhere (server version 2)
  const other = await page.request.patch(`/api/v1/contacts/${id}`, { data: { jobTitle: "부장(다른 기기)", version: 1 } });
  expect(other.status()).toBe(200);

  await context.setOffline(false);
  await expect(page.getByTestId("offline-indicator")).toContainText("확인 필요 1", { timeout: 15_000 });

  // the note was replayed exactly once (Idempotency-Key)
  const timeline = await (await page.request.get(`/api/v1/contacts/${id}`)).json();
  expect(timeline.notes.filter((n: any) => n.body === "전시회 부스에서 만남")).toHaveLength(1);
  expect(timeline.contact.jobTitle).toBe("부장(다른 기기)");

  await page.goto("/app/sync");
  const conflict = page.getByTestId("outbox-conflict");
  await expect(conflict).toContainText("연락처 수정");
  await expect(conflict).toContainText("이사(오프라인 수정)");
  await expect(conflict).toContainText("부장(다른 기기)");
  await conflict.getByRole("button", { name: "내 변경 적용" }).click();
  await expect(page.getByText("모두 동기화됐어요")).toBeVisible({ timeout: 15_000 });
  const after = await (await page.request.get(`/api/v1/contacts/${id}`)).json();
  expect(after.contact.jobTitle).toBe("이사(오프라인 수정)");
  expect(after.contact.version).toBe(3);
});
