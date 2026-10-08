// E2E — UI gap fill: UX-002 교환 시작 4 CTA (QR 미노출) · F-143 이 행사로 교환 시작 · UX-014/F-080 음성 메모 CTA ·
// UX-006 게스트 뒷면 단계 · UX-021/F-145/F-146 추천 필터·이유·현장 미팅 요청 · F-142 참가자 등록 · F-147 부스 스태프 ·
// UX-015 녹음 마커 · F-090 녹음 정책 선택 · UX-017/018 AI 오류+다시 시도 · UX-020 Room 없음 상태
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

async function profile(page: Page, name: string) {
  const r = await page.request.post("/api/v1/profiles", { data: { name, company: `${name}사`, jobTitle: "대표", industries: ["헬스케어"], regions: ["서울"] } });
  expect(r.status()).toBe(201);
}

test("exchange start: four CTAs, event-tagged exchange, guest back-side option, voice memo CTA", async ({ page, browser }) => {
  await signIn(page, `gx${uniq()}@linkos.test`);
  await profile(page, "주최자");
  const ev = await (await page.request.post("/api/v1/events", { data: { name: "E2E 엑스포" } })).json();

  await page.goto("/app/exchange");
  const ctas = page.getByTestId("exchange-ctas");
  await expect(ctas).toBeVisible();
  await expect(page.getByTestId("start-exchange")).toBeVisible();
  await expect(page.getByTestId("receive-mode-start")).toBeVisible();
  await expect(page.getByTestId("exchange-scan")).toHaveAttribute("href", "/app/scan");
  await expect(page.getByTestId("exchange-group")).toHaveAttribute("href", /group=1/);
  await expect(page.getByTestId("qr-fallback")).toHaveCount(0); // QR is never a start option

  // F-143 from the event page
  await page.goto(`/app/events/${ev.id}`);
  await page.getByTestId("event-exchange-start").click();
  await page.waitForURL(new RegExp(`event=${ev.id}`));
  await expect(page.getByTestId("exchange-event-tag")).toContainText("E2E 엑스포");
  const [created] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/v1/exchange/sessions") && r.request().method() === "POST"), page.getByTestId("start-exchange").click()]);
  const session = await created.json();
  expect(session.eventId).toBe(ev.id);

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(new URL(session.url).pathname);
  await expect(guest.getByText("E2E 엑스포")).toBeVisible(); // event name is the place label
  await guest.getByTestId("reply-cta").click();
  // UX-006: optional back side, off by default
  await expect(guest.getByTestId("guest-two-sided")).not.toBeChecked();
  await guest.getByTestId("guest-two-sided").check();
  await expect(guest.getByText("앞면을 먼저 촬영하세요.")).toBeVisible();
  await guest.getByTestId("manual-entry").click();
  await guest.locator('input[name="fullName"]').fill("현장손님");
  await guest.locator('input[name="consent"]').check();
  await guest.getByTestId("send-cta").click();
  await expect(guest.getByRole("heading", { name: /교환 완료/ })).toBeVisible();
  await guestCtx.close();

  await expect(page.getByTestId("exchange-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("exchange-voice-note")).toHaveAttribute("href", /^\/app\/people\/[0-9a-f-]{36}\?voice=1#note$/);

  await page.goto(`/app/events/${ev.id}`);
  await expect(page.getByText("현장손님")).toBeVisible();
});

test("event: recommendation filter + all reasons + meeting request, attendee CSV registration, booth staff", async ({ page, browser }) => {
  await signIn(page, `eo${uniq()}@linkos.test`);
  await profile(page, "오거나이저");
  const ev = await (await page.request.post("/api/v1/events", { data: { name: "매칭 행사" } })).json();

  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await signIn(other, `ea${uniq()}@linkos.test`);
  await profile(other, "참가자비");
  expect((await other.request.post("/api/v1/events/join", { data: { joinCode: ev.joinCode, optIn: true } })).ok()).toBeTruthy();
  await otherCtx.close();

  await page.goto(`/app/events/${ev.id}`);
  const recs = page.getByTestId("event-recs");
  await expect(recs).toContainText("참가자비");
  await expect(recs).toContainText("공통 산업");
  await expect(recs).toContainText("활동 지역"); // every reason, not just the first
  await page.getByRole("button", { name: "같은 지역" }).click();
  await expect(recs).toContainText("참가자비");

  await page.getByTestId("match-meeting-request").click();
  const form = page.getByTestId("match-meeting-form");
  const t = new Date(Date.now() + 86_400_000);
  const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await form.getByLabel("후보 1").fill(local);
  await form.getByRole("button", { name: "요청 보내기" }).click();
  await expect(page.getByText("요청 보냄 · 응답 대기")).toBeVisible();

  // F-142 organizer registration by paste
  const reg = page.getByTestId("attendee-registration");
  await reg.getByTestId("attendee-paste").fill(`이름,이메일,회사,직책\n사전일,pre1${uniq()}@x.test,A사,팀장\n사전이,,B사,`);
  await expect(reg.getByTestId("attendee-preview-count")).toContainText("2명 인식");
  await reg.getByTestId("attendee-submit").click();
  await expect(reg.getByText(/새로 2명 등록/)).toBeVisible();
  await expect(reg.getByTestId("attendee-list")).toContainText("사전일");
  await expect(reg.getByTestId("attendee-list")).toContainText("사전이");

  // F-147 booth staff from joined attendees
  await page.goto(`/app/events/${ev.id}/booth`);
  const team = page.getByTestId("booth-team");
  await team.getByLabel("스태프로 추가할 참가자").selectOption({ label: "참가자비 · 참가자비사" });
  await team.getByTestId("booth-staff-add").click();
  await expect(team.getByText("참가자비님을 부스 팀에 추가했어요.")).toBeVisible();
  await team.getByRole("button", { name: "참가자비 부스 팀에서 빼기" }).click();
  await expect(team.getByText("참가자비님을 부스 팀에서 뺐어요.")).toBeVisible();
});

test("meeting: recording policy selector and a marker shown on the transcript timeline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "fake media devices are Chromium-only");
  await signIn(page, `mk${uniq()}@linkos.test`);
  const m = await (await page.request.post("/api/v1/meetings", { data: { title: "마커 테스트" } })).json();
  await page.goto(`/app/meetings/${m.id}`);
  const policy = page.getByTestId("recording-policy");
  await expect(policy.getByRole("radio", { name: /모든 참석자 동의/ })).toBeChecked();
  await policy.getByRole("radio", { name: /한쪽 동의/ }).check();
  await expect(page.getByText("참여자에게 녹음 중임을 알렸습니다 (권장)")).toBeVisible();
  await policy.getByRole("radio", { name: /모든 참석자 동의/ }).check();
  await expect(page.getByTestId("record-start")).toBeDisabled(); // still blocked until consent is recorded
  await page.getByLabel("녹음·전사에 동의합니다").check();
  await page.getByLabel("모든 참여자에게 녹음 사실을 알리고 동의를 받았습니다").check();
  await page.getByRole("button", { name: "동의 기록" }).click();
  await expect(page.getByText("동의가 기록되었습니다.")).toBeVisible();
  await page.getByTestId("record-start").click();
  await expect(page.getByTestId("record-stop")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByLabel("마커 라벨 (선택)").fill("가격 이야기");
  await page.getByTestId("record-marker").click();
  await expect(page.getByTestId("record-markers")).toContainText("가격 이야기");
  await page.getByTestId("record-stop").click();
  await expect(page.getByTestId("record-start")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("transcript-marker").first()).toContainText("가격 이야기");
  const detail = await (await page.request.get(`/api/v1/meetings/${m.id}`)).json();
  expect(detail.markers).toHaveLength(1);
});

test("AI hub shows errors with retry; an unknown room shows a not-found state", async ({ page }) => {
  await signIn(page, `ai${uniq()}@linkos.test`);
  let fail = true;
  await page.route("**/api/v1/matches", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "error", message: "서버 오류" }) }) : route.continue()));
  await page.goto("/app/ai");
  await page.getByRole("tab", { name: "Need ↔ Offer 매칭" }).click();
  await expect(page.getByTestId("ai-error")).toContainText("매칭을 불러오지 못했어요");
  fail = false;
  await page.getByTestId("ai-retry").click();
  await expect(page.getByTestId("ai-error")).toHaveCount(0);

  await page.route("**/api/v1/ai/search", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "잠시 후 다시 시도하세요" }) }));
  await page.getByRole("tab", { name: "관계 기억 검색" }).click();
  await page.getByLabel("자연어 관계 검색").fill("의료 AI 대표");
  await page.getByRole("button", { name: "찾기" }).click();
  await expect(page.getByTestId("ai-error")).toContainText("검색하지 못했어요");

  await page.goto("/app/rooms/00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("room-error")).toContainText("방을 찾을 수 없어요");
});
