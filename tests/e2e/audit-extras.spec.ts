// Audit 2026-10 + extras over real HTTP/UI:
// X-001 X-002 X-003 X-004 X-005 X-006 X-007, G-03 guest SSE, G-04 generic Idempotency-Key,
// F-041 OS share, F-057 Contact Picker, F-063 first-share prompt, F-103 CTAs, F-174 PWA, F-182 deep-link files.
import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import pg from "pg";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const DB = process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos";

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

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

/** Card via the API (the editor UI is covered by guest-exchange.spec.ts). */
async function apiCard(page: Page, name: string) {
  const r = await page.request.post("/api/v1/profiles", {
    data: { name, company: "링코스랩", jobTitle: "대표", headline: "의료 AI", fields: [{ type: "email", value: `ceo${uniq()}@linkos.test`, visibility: "business" }, { type: "mobile", value: "010-2222-3333", visibility: "trusted" }], offers: [], needs: [] },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test.describe.configure({ mode: "serial" });

test("X-001/X-002/X-004/X-007 share kit from /app/me", async ({ page, browser }) => {
  await signIn(page, `share${uniq()}@linkos.test`);
  await apiCard(page, "공유왕");
  await page.goto("/app/me");
  await page.getByTestId("share-kit-link").click();
  await page.waitForURL(/\/app\/me\/share/);

  // X-001 signature: escaped HTML preview in a sandboxed iframe + plain text with the tracked link
  await page.getByText("텍스트 서명 보기").click();
  const text = page.getByTestId("signature-text");
  await expect(text).toContainText("공유왕");
  await expect(text).toContainText("?src=sig");
  await expect(text).not.toContainText("010-2222-3333"); // trusted field never in a signature
  await expect(page.getByTestId("signature-preview")).toHaveAttribute("sandbox", "");
  await page.getByRole("tab", { name: "파스텔" }).click();
  await expect(page.getByRole("tab", { name: "파스텔" })).toHaveAttribute("aria-selected", "true");

  // X-002 virtual background: 1920×1080 PNG generated on the client after a click
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("bg-download").click()]);
  expect(dl.suggestedFilename()).toBe("linkos-background-pastel.png");
  const png = readFileSync((await dl.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1920);
  expect(png.readUInt32BE(20)).toBe(1080);

  // X-004 wallet: not configured in this environment → explained, no download offered
  await expect(page.getByTestId("apple-wallet-off")).toBeVisible();
  await expect(page.getByTestId("google-wallet-off")).toBeVisible();
  const apple = await page.request.get("/api/v1/me/wallet/apple");
  expect(apple.status()).toBe(501);
  expect((await apple.json()).code).toBe("wallet_not_configured");

  // X-007 poster: short code is the hero; PDF downloads; the code works for a guest
  await page.getByRole("radio", { name: "A4 포스터" }).click();
  await page.getByLabel("장소·행사 이름 (선택)").fill("E2E 부스");
  await page.getByTestId("poster-create").click();
  const code = (await page.getByTestId("poster-code").textContent())!.replace(/\s/g, "");
  expect(code).toMatch(/^[2-9A-Z]{6}$/);
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("poster-download").click()]);
  expect(pdf.suggestedFilename()).toBe("linkos-poster-a4.pdf");
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/c/${code}`);
  await expect(guest.getByRole("heading", { name: /공유왕님의/ })).toBeVisible();
  await guestCtx.close();
});

test("X-003 card view analytics: counts views/CTA/vCard, respects GPC and opt-out", async ({ page, browser }) => {
  await signIn(page, `views${uniq()}@linkos.test`);
  await apiCard(page, "조회왕");
  const s = await (await page.request.post("/api/v1/exchange/sessions", { data: { group: true, capabilities: { online: true }, context: { placeLabel: "뷰 테스트" } } })).json();

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/c/${s.shortCode}`);
  await expect(guest.getByRole("heading", { name: /조회왕님의/ })).toBeVisible();
  // F-103 contact CTA (business email) is a real mailto: link
  const mail = guest.locator('a[href^="mailto:"]').first();
  await expect(mail).toBeVisible();
  await mail.evaluate((a) => a.addEventListener("click", (e) => e.preventDefault(), { once: true }));
  const cta = guest.waitForResponse((r) => r.url().includes("/api/v1/card-views") && r.status() === 202);
  await mail.click();
  await cta;
  const vc = guest.waitForResponse((r) => r.url().includes("/api/v1/card-views") && r.status() === 202);
  await guest.getByRole("button", { name: "연락처에 저장 (vCard)" }).click();
  await vc;
  await guestCtx.close();

  // a GPC browser is not counted
  const gpcCtx = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
  const gpcPage = await gpcCtx.newPage();
  await gpcPage.goto(`/c/${s.shortCode}`);
  await expect(gpcPage.getByRole("heading", { name: /조회왕님의/ })).toBeVisible();
  await gpcCtx.close();

  await page.goto("/app/insights");
  await expect(page.getByTestId("cv-view")).toHaveText("1");
  await expect(page.getByTestId("cv-cta")).toHaveText("1");
  await expect(page.getByTestId("cv-vcard")).toHaveText("1");
  await expect(page.getByTestId("card-views")).toContainText("뷰 테스트");

  // opt-out from settings → counting stops, insights says so
  await page.goto("/app/settings");
  await page.getByTestId("analytics-toggle").click();
  await expect(page.getByText("카드 조회 집계를 껐고")).toBeVisible();
  await page.goto("/app/insights");
  await expect(page.getByTestId("card-views-off")).toBeVisible();
  const pref = await (await page.request.get("/api/v1/me/analytics-preference")).json();
  expect(pref.optOut).toBe(true);
});

test("X-005 prep brief + X-006 re-connect digest (draft only)", async ({ page }) => {
  await signIn(page, `assist${uniq()}@linkos.test`);
  await apiCard(page, "비서왕");
  const me = await (await page.request.get("/api/v1/me")).json();
  const old = new Date(Date.now() - 150 * 864e5).toISOString();
  const c = await (await page.request.post("/api/v1/contacts", { data: { fullName: "오래된친구", company: "옛회사", source: "manual", tags: ["vip"], encounter: { placeLabel: "판교 카페", occurredAt: old } } })).json();
  const contactId = c.contactId ?? c.contact?.id;
  await sql("UPDATE relationships SET last_contact_at=NULL WHERE owner_user_id=$1", [me.user.id]);
  const [cand] = await sql<{ id: string }>(
    "INSERT INTO calendar_candidates (owner_user_id, source, contact_id, title, starts_at, ends_at, status) VALUES ($1,'manual',$2,'근황 점심',now() + interval '2 hours', now() + interval '3 hours','approved') RETURNING id",
    [me.user.id, contactId],
  );

  // X-005: brief list + detail (records only)
  await page.goto("/app/insights");
  await page.getByTestId("brief-link").click();
  await expect(page.getByTestId("brief-list")).toContainText("근황 점심");
  await page.goto(`/app/brief/${cand!.id}`);
  await expect(page.getByTestId("brief-items")).toContainText("오래된친구");
  await expect(page.getByTestId("brief-items")).toContainText("판교 카페");
  // another user cannot open it
  const other = await page.context().browser()!.newContext();
  const op = await other.newPage();
  await signIn(op, `assist-other${uniq()}@linkos.test`);
  expect((await op.request.get(`/api/v1/prep-briefs/${cand!.id}`)).status()).toBe(404);
  await other.close();

  // settings: lead time can be changed / turned off
  await page.goto("/app/settings");
  await page.getByTestId("prep-lead").selectOption("60");
  await expect(page.getByText("저장했어요.")).toBeVisible();
  expect((await (await page.request.get("/api/v1/me/assistant-preferences")).json()).prepBriefLeadMin).toBe(60);

  // X-006: digest → one-tap draft, saved but not sent
  await page.goto("/app/reconnect");
  await expect(page.getByTestId("reconnect-list")).toContainText("오래된친구");
  await page.getByTestId("reconnect-draft-btn").first().click();
  await expect(page.getByTestId("reconnect-draft")).toContainText("초안 저장됨");
  await expect(page.getByTestId("reconnect-draft")).toContainText("판교 카페");
  const msgs = await (await page.request.get("/api/v1/messages")).json();
  const list = msgs.messages ?? msgs;
  expect(list.some((m: any) => m.status === "draft" && m.contactId === contactId)).toBe(true);
  expect(list.some((m: any) => m.status === "sent")).toBe(false);
});

test("X-007 entry points from /app/events", async ({ page }) => {
  await signIn(page, `ev${uniq()}@linkos.test`);
  await page.goto("/app/events");
  await page.getByTestId("events-poster-link").click();
  await page.waitForURL(/\/app\/me\/(share|edit)/);
});

test("G-04 generic Idempotency-Key: a retried create replays instead of duplicating", async ({ page }) => {
  await signIn(page, `idem${uniq()}@linkos.test`);
  const key = `e2e-${uniq()}`;
  const body = { kind: "custom", title: `멱등 ${key}` };
  const a = await page.request.post("/api/v1/followups", { data: body, headers: { "idempotency-key": key } });
  const b = await page.request.post("/api/v1/followups", { data: body, headers: { "idempotency-key": key } });
  expect(a.status()).toBe(201);
  expect(b.status()).toBe(201);
  expect(b.headers()["idempotent-replayed"]).toBe("true");
  expect((await b.json()).id).toBe((await a.json()).id);
  const open = await (await page.request.get("/api/v1/followups")).json();
  expect(open.followups.filter((f: any) => f.title === body.title)).toHaveLength(1);
  const c = await page.request.post("/api/v1/followups", { data: { ...body, title: "다른 본문" }, headers: { "idempotency-key": key } });
  expect(c.status()).toBe(409);
});

test("G-03 guest SSE status, F-041 OS share, F-063 next exchange, F-057 Contact Picker", async ({ page, browser }) => {
  await page.addInitScript(() => {
    (navigator as any).share = async (d: ShareData) => {
      (window as any).__shared = d;
    };
  });
  await signIn(page, `osshare${uniq()}@linkos.test`);
  await apiCard(page, "공유테스트");
  await page.goto("/app/exchange");
  await page.getByTestId("start-exchange").click();
  await page.getByTestId("os-share").click();
  const shared = await page.waitForFunction(() => (window as any).__shared?.url as string | undefined);
  const url = (await shared.jsonValue())!;
  expect(url).toMatch(/\/x\/[A-Za-z0-9_-]{20,}$/);
  const token = url.split("/x/")[1]!;

  const sse = await page.request.get(`/api/v1/exchange/sessions/${token}/events?once=1`);
  expect(sse.headers()["content-type"]).toContain("text/event-stream");
  const ev = await sse.text();
  expect(ev).toContain("event: status");
  expect(ev).toContain('"acceptsReply":true');
  expect(ev).not.toContain("공유테스트"); // no card data on the guest stream

  // F-057: Contact Picker fills the reply form (only in supporting browsers — stubbed here)
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.addInitScript(() => {
    (window as any).ContactsManager = function () {};
    (navigator as any).contacts = { select: async () => [{ name: ["피커 사용자"], email: ["picker@x.test"], tel: ["010-1111-2222"] }] };
  });
  await guest.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await guest.getByTestId("reply-cta").click();
  await guest.getByRole("button", { name: "직접 입력할게요" }).click();
  await guest.getByTestId("contact-picker").click();
  await expect(guest.locator('input[name="fullName"]')).toHaveValue("피커 사용자");
  await expect(guest.locator('input[name="email"]')).toHaveValue("picker@x.test");
  await guest.locator('input[name="consent"]').check();
  await guest.getByTestId("send-cta").click();
  await expect(guest.getByRole("heading", { name: /교환 완료/ })).toBeVisible();
  await guestCtx.close();

  // F-063: after a completed exchange the sender is prompted to share with the next person
  await expect(page.getByTestId("exchange-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "다음 사람과 교환" })).toBeVisible();
  const after = await (await page.request.get(`/api/v1/exchange/sessions/${token}/events?once=1`)).text();
  expect(after).toContain('"acceptsReply":false');
});

test("F-174 PWA + F-182 deep-link association files are served", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.ok()).toBeTruthy();
  const manifest = JSON.parse(await m.text());
  expect(manifest.start_url).toBeTruthy();
  expect(manifest.icons.length).toBeGreaterThan(0);
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBeTruthy();
  expect(sw.headers()["content-type"]).toContain("javascript");
  const aasa = await request.get("/.well-known/apple-app-site-association");
  expect(aasa.ok()).toBeTruthy();
  expect(JSON.parse(await aasa.text()).applinks).toBeTruthy();
  const al = await request.get("/.well-known/assetlinks.json");
  expect(al.ok()).toBeTruthy();
  expect(Array.isArray(JSON.parse(await al.text()))).toBe(true);
});
